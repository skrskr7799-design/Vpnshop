import type { AuthProvider, Prisma, User } from "@prisma/client";
import { isUniqueViolation } from "../../lib/db-errors";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { lockIdentityOwner, requireLiveFamily } from "../auth/session.service";
import type { AuthClaims } from "../auth/jwt";
import type { ProviderProfile } from "./oauth.types";

const findIdentity = (provider: AuthProvider, providerId: string) =>
  prisma.authIdentity.findUnique({
    where: { provider_providerId: { provider, providerId } },
    include: { user: true },
  });

export async function loginWithProfile(provider: AuthProvider, profile: ProviderProfile): Promise<User> {
  const existing = await findIdentity(provider, profile.providerId);
  if (existing) return assertActive(existing.user);

  // Неподтверждённый email не используем ни для поиска, ни для сохранения
  if (profile.email && !profile.emailVerified) throw new AppError(403, "EMAIL_NOT_VERIFIED");
  const email = profile.email;
  const now = new Date();

  try {
    const user = await prisma.$transaction(async (tx) => {
      const byEmail = email ? await tx.user.findUnique({ where: { email } }) : null;
      if (byEmail) throw new AppError(409, "EXPLICIT_LINK_REQUIRED");
      return tx.user.create({
        data: {
          email,
          emailVerifiedAt: email ? now : null,
          identities: { create: { provider, providerId: profile.providerId, verifiedAt: now } },
        },
      });
    });
    return assertActive(user);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Параллельный вход мог уже создать эту привязку
    const raced = await findIdentity(provider, profile.providerId);
    if (raced) return assertActive(raced.user);
    // У пользователя с этим email уже подключён другой аккаунт этого сервиса
    throw new AppError(409, "EXPLICIT_LINK_REQUIRED");
  }
}

// Привязка внешнего аккаунта к уже вошедшему пользователю.
export async function linkProfile(claims: AuthClaims, provider: AuthProvider, profile: ProviderProfile): Promise<void> {
  try {
    await prisma.$transaction(async db => {
      const user = await lockIdentityOwner(db, claims.userId);
      await requireLiveFamily(claims, db);
      if (!user) throw new AppError(401, "UNAUTHENTICATED");
      const existing = await db.authIdentity.findUnique({
        where: { provider_providerId: { provider, providerId: profile.providerId } },
      });
      if (existing && existing.userId !== user.id) throw new AppError(409, "IDENTITY_TAKEN");
      if (existing) return;
      if (await db.authIdentity.findUnique({ where: { userId_provider: { userId: user.id, provider } } })) {
        throw new AppError(409, "PROVIDER_ALREADY_LINKED");
      }
      const now = new Date();
      await db.authIdentity.create({ data: { userId: user.id, provider, providerId: profile.providerId, verifiedAt: now } });
      if (!user.email && profile.email && profile.emailVerified &&
          !await db.user.findUnique({ where: { email: profile.email } })) {
        await db.user.update({ where: { id: user.id }, data: { email: profile.email, emailVerifiedAt: now } });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "LINK_CONFLICT");
    throw err;
  }
}

export function consumeProof(db: Prisma.TransactionClient, claims: AuthClaims, id: string, target: AuthProvider, purpose: string) {
  const now = new Date();
  return db.identityProof.updateMany({
    where: { id, familyId: claims.sid, target, purpose, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now },
  });
}

export async function listLinkedProviders(userId: string): Promise<AuthProvider[]> {
  const identities = await prisma.authIdentity.findMany({ where: { userId }, select: { provider: true } });
  return identities.map((i) => i.provider);
}

function assertActive(user: User): User {
  if (user.status !== "ACTIVE" || user.role !== "USER") throw new AppError(403, "ACCOUNT_BLOCKED");
  return user;
}
