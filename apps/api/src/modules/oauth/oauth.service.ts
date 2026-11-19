import type { AuthProvider, User } from "@prisma/client";
import { isUniqueViolation } from "../../lib/db-errors";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import type { ProviderProfile } from "./oauth.types";

const findIdentity = (provider: AuthProvider, providerId: string) =>
  prisma.authIdentity.findUnique({
    where: { provider_providerId: { provider, providerId } },
    include: { user: true },
  });

// Вход или регистрация через внешний сервис. Правила объединения аккаунтов:
//  1. Этот внешний аккаунт уже привязан -> входим в его пользователя.
//  2. Есть пользователь с таким же ПОДТВЕРЖДЁННЫМ email -> привязываем к нему. Это безопасно:
//     оба email подтверждены (у нас по ссылке, у Google самим Google), значит ящик один и тот же.
//     Аккаунт по почте у нас создаётся только после подтверждения, поэтому «занять» чужой email заранее нельзя.
//  3. Иначе создаём нового пользователя (у Telegram email нет).
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
      if (byEmail) {
        await tx.authIdentity.create({
          data: { userId: byEmail.id, provider, providerId: profile.providerId, verifiedAt: now },
        });
        return byEmail;
      }
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
    throw new AppError(409, "PROVIDER_ALREADY_LINKED");
  }
}

// Привязка внешнего аккаунта к уже вошедшему пользователю.
export async function linkProfile(userId: string, provider: AuthProvider, profile: ProviderProfile): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(401, "UNAUTHENTICATED");
  assertActive(user);

  const existing = await findIdentity(provider, profile.providerId);
  if (existing) {
    if (existing.userId === userId) return; // уже привязан к вам
    throw new AppError(409, "IDENTITY_TAKEN");
  }

  const sameProvider = await prisma.authIdentity.findUnique({
    where: { userId_provider: { userId, provider } },
  });
  if (sameProvider) throw new AppError(409, "PROVIDER_ALREADY_LINKED");

  // Email подтягиваем, только если у пользователя его нет, он подтверждён провайдером и никем не занят
  let emailToSet: string | null = null;
  if (!user.email && profile.email && profile.emailVerified) {
    const owner = await prisma.user.findUnique({ where: { email: profile.email }, select: { id: true } });
    if (!owner) emailToSet = profile.email;
  }

  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.authIdentity.create({ data: { userId, provider, providerId: profile.providerId, verifiedAt: now } });
      if (emailToSet) {
        await tx.user.update({ where: { id: userId }, data: { email: emailToSet, emailVerifiedAt: now } });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "LINK_CONFLICT");
    throw err;
  }
}

export async function listLinkedProviders(userId: string): Promise<AuthProvider[]> {
  const identities = await prisma.authIdentity.findMany({ where: { userId }, select: { provider: true } });
  return identities.map((i) => i.provider);
}

function assertActive(user: User): User {
  if (user.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_BLOCKED");
  return user;
}
