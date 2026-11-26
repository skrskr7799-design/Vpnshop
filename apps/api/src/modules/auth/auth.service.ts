import { emailAvailable, env } from "../../config/env";
import { enqueueMail } from "../mail/outbox";
import type { FastifyBaseLogger } from "fastify";
import type {
  ForgotPasswordInput,
  LoginInput,
  PublicUser,
  RegisterInput,
  ResetPasswordInput,
} from "@vpn/shared";
import type { Prisma, User } from "@prisma/client";
import { generateToken, sha256 } from "../../lib/crypto";
import { isUniqueViolation } from "../../lib/db-errors";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { sendMail } from "../mail/mail.service";
import { accountExistsMail, resetPasswordMail, verifyEmailMail } from "../mail/mail.templates";
import { MAX_MAILS_PER_EMAIL_PER_HOUR, RESET_TTL_MS, VERIFY_TTL_MS } from "./auth.constants";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password";
import { createSession, lockIdentityOwner, requireLiveFamily, revokeAllUserSessions, type IssuedTokens } from "./session.service";

import { consumeProof } from "../oauth/oauth.service";
import type { AuthClaims } from "./jwt";

export type AuthContext = { log: FastifyBaseLogger; ip?: string; userAgent?: string };

const HOUR_MS = 60 * 60 * 1000;

async function consumeMailBudget(email: string, purpose: string) {
  const key = sha256(`${purpose}:${email}`);
  const now = new Date();
  const expired = new Date(+now - HOUR_MS);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "AuthMailWindow" (key, "startedAt", count) VALUES (${key}, ${now}, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN "AuthMailWindow"."startedAt" <= ${expired} THEN 1 ELSE "AuthMailWindow".count + 1 END,
      "startedAt" = CASE WHEN "AuthMailWindow"."startedAt" <= ${expired} THEN ${now} ELSE "AuthMailWindow"."startedAt" END
    WHERE "AuthMailWindow"."startedAt" <= ${expired} OR "AuthMailWindow".count < ${MAX_MAILS_PER_EMAIL_PER_HOUR}
    RETURNING count`;
  return rows.length > 0;
}

export const toPublicUser = (user: Pick<User, "id" | "email" | "role" | "emailVerifiedAt">): PublicUser => ({
  id: user.id,
  email: user.email,
  role: user.role,
  emailVerified: !!user.emailVerifiedAt,
});

// ───────────── Регистрация ─────────────
// Всегда отвечает одинаково (наружу ничего не утекает): есть такой аккаунт или нет,
// узнать можно только из письма на этот адрес.
export async function register({ email, password }: RegisterInput, ctx: AuthContext): Promise<void> {
  if (!await consumeMailBudget(email, "register")) return;
  // хэшируем всегда, чтобы время ответа не зависело от наличия аккаунта
  const passwordHash = await hashPassword(password);
  const now = new Date();

  // оппортунистическая чистка; позже переедет в фоновый воркер
  await prisma.pendingRegistration.deleteMany({ where: { expiresAt: { lt: now } } });

  const existing = await prisma.user.findFirst({
    where: { OR: [{ email }, { identities: { some: { provider: "EMAIL", providerId: email } } }] },
    select: { id: true },
  });
  if (existing) {
    if (!emailAvailable) return;
    const mail = accountExistsMail(email);
    if (env.MAIL_QUEUE_KEY) await enqueueMail(prisma, mail, new Date(+now + VERIFY_TTL_MS));
    else void sendMail(ctx.log, mail);
    return;
  }

  const token = generateToken();
  const mail = verifyEmailMail(email, token);
  const expiresAt = new Date(+now + VERIFY_TTL_MS);
  await prisma.$transaction(async db => {
    await db.pendingRegistration.create({ data: { email, passwordHash, tokenHash: sha256(token), expiresAt } });
    if (emailAvailable) await enqueueMail(db, mail, expiresAt);
  });
  if (emailAvailable && !env.MAIL_QUEUE_KEY) void sendMail(ctx.log, mail);
}

// Serialize creation by email before consuming one of several pending requests.
export async function lockRegistration(db: Prisma.TransactionClient, email: string) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"registration:" + email}, 0))`;
}

export async function verifyEmail(token: string, claims?: AuthClaims): Promise<void> {
  const tokenHash = sha256(token);
  try {
    await prisma.$transaction(async db => {
      const now = new Date();
      const pending = await db.pendingRegistration.findUnique({ where: { tokenHash } });
      if (pending) {
        await lockRegistration(db, pending.email);
        const taken = await db.pendingRegistration.deleteMany({ where: { id: pending.id, expiresAt: { gt: now } } });
        if (taken.count !== 1) throw new AppError(400, "INVALID_TOKEN");
        await createEmailAccount(db, { email: pending.email, passwordHash: pending.passwordHash, emailVerifiedAt: now });
        await db.pendingRegistration.deleteMany({ where: { email: pending.email } });
        return;
      }
      const record = await db.verificationToken.findUnique({ where: { tokenHash } });
      if (!record?.email || record.type !== "VERIFY_EMAIL" || record.usedAt || record.expiresAt <= now)
        throw new AppError(400, "INVALID_TOKEN");
      const owner = await lockIdentityOwner(db, record.userId);
      if (!owner || owner.role !== "USER" || owner.status !== "ACTIVE" || owner.emailVerifiedAt ||
          (owner.email && owner.email !== record.email)) throw new AppError(400, "INVALID_TOKEN");
      if (record.familyId) {
        if (claims?.sid !== record.familyId || claims.userId !== owner.id) throw new AppError(401, "VERIFICATION_SESSION_REQUIRED");
        await requireLiveFamily(claims, db);
      }
      const used = await db.verificationToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now },
      });
      if (used.count !== 1) throw new AppError(400, "INVALID_TOKEN");
      await db.user.update({ where: { id: owner.id }, data: {
        email: record.email, emailVerifiedAt: now, activationRequired: false,
      } });
      await db.authIdentity.updateMany({
        where: { userId: owner.id, provider: "EMAIL", providerId: record.email }, data: { verifiedAt: now },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(400, "INVALID_TOKEN");
    throw err;
  }
}

export async function requestEmailVerification(email: string, ctx: AuthContext, confirmation?: { claims: AuthClaims; id: string }) {
  if (!emailAvailable) {
    if (confirmation) throw new AppError(503, "EMAIL_UNAVAILABLE");
    return;
  }
  if (!await consumeMailBudget(email, "verify")) {
    if (confirmation) throw new AppError(429, "RATE_LIMIT_EXCEEDED");
    return;
  }
  const candidate = confirmation ? { id: confirmation.claims.userId } : await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!candidate) return;
  const token = generateToken();
  const mail = verifyEmailMail(email, token);
  const issued = await prisma.$transaction(async db => {
    const owner = await lockIdentityOwner(db, candidate.id);
    if (!owner || owner.role !== "USER" || owner.status !== "ACTIVE" || owner.emailVerifiedAt ||
        (confirmation ? !!owner.email && owner.email !== email : owner.email !== email)) return false;
    if (confirmation) {
      await requireLiveFamily(confirmation.claims, db);
      if (!(await consumeProof(db, confirmation.claims, confirmation.id, "EMAIL", "VERIFY_EMAIL")).count)
        throw new AppError(403, "REAUTH_REQUIRED");
    }
    const now = new Date();
    const expiresAt = new Date(+now + VERIFY_TTL_MS);
    const familyId = confirmation?.claims.sid ?? null;
    await db.verificationToken.updateMany({
      where: { userId: owner.id, type: "VERIFY_EMAIL", familyId, usedAt: null }, data: { usedAt: now },
    });
    await db.verificationToken.create({ data: { userId: owner.id, type: "VERIFY_EMAIL", familyId, email, tokenHash: sha256(token), expiresAt } });
    await enqueueMail(db, mail, expiresAt);
    return true;
  });
  if (!issued && confirmation) throw new AppError(409, "EMAIL_UPDATE_UNAVAILABLE");
  if (issued && !env.MAIL_QUEUE_KEY) void sendMail(ctx.log, mail);
}

export async function setEmailPassword(claims: AuthClaims, confirmationId: string, password: string) {
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async db => {
    const owner = await lockIdentityOwner(db, claims.userId);
    await requireLiveFamily(claims, db);
    if (!owner?.email || !owner.emailVerifiedAt) throw new AppError(409, "EMAIL_NOT_VERIFIED");
    if (!(await consumeProof(db, claims, confirmationId, "EMAIL", "SET_PASSWORD")).count)
      throw new AppError(403, "REAUTH_REQUIRED");
    await db.authIdentity.upsert({
      where: { userId_provider: { userId: owner.id, provider: "EMAIL" } },
      create: { userId: owner.id, provider: "EMAIL", providerId: owner.email, passwordHash, verifiedAt: owner.emailVerifiedAt },
      update: { passwordHash, temporaryPasswordExpiresAt: null },
    });
    await db.user.update({ where: { id: owner.id }, data: { emailLoginDisabled: false } });
    await db.verificationToken.updateMany({ where: { userId: owner.id, type: "PASSWORD_RESET", usedAt: null }, data: { usedAt: new Date() } });
    await revokeAllUserSessions(owner.id, db);
  });
}

export function createEmailAccount(db: Prisma.TransactionClient, input: {
  email: string; passwordHash: string; emailVerifiedAt?: Date; displayName?: string;
  activationRequired?: boolean; manualActivatedAt?: Date; temporaryPasswordExpiresAt?: Date;
}) {
  const { passwordHash, temporaryPasswordExpiresAt, ...user } = input;
  return db.user.create({ data: { ...user, identities: { create: {
    provider: "EMAIL", providerId: user.email, passwordHash, verifiedAt: user.emailVerifiedAt, temporaryPasswordExpiresAt,
  } } }, select: { id: true } });
}

export async function changeTemporaryUserPassword(email: string, temporaryPassword: string, password: string) {
  const identity = await prisma.authIdentity.findUnique({ where: { provider_providerId: { provider: "EMAIL", providerId: email } } });
  const valid = identity?.passwordHash ? await verifyPassword(identity.passwordHash, temporaryPassword)
    : (await verifyAgainstDummy(temporaryPassword), false);
  if (!identity || !valid || !identity.temporaryPasswordExpiresAt || identity.temporaryPasswordExpiresAt <= new Date())
    throw new AppError(401, "INVALID_CREDENTIALS");
  if (temporaryPassword === password) throw new AppError(400, "PASSWORD_MUST_CHANGE");
  const passwordHash = await hashPassword(password);
  await prisma.$transaction(async db => {
    const owner = await lockIdentityOwner(db, identity.userId);
    if (!owner || owner.role !== "USER" || owner.status !== "ACTIVE" || owner.emailLoginDisabled)
      throw new AppError(403, "ACCOUNT_BLOCKED");
    const consumed = await db.authIdentity.updateMany({
      where: { id: identity.id, passwordHash: identity.passwordHash, temporaryPasswordExpiresAt: { gt: new Date() } },
      data: { passwordHash, temporaryPasswordExpiresAt: null },
    });
    if (consumed.count !== 1) throw new AppError(401, "INVALID_CREDENTIALS");
    await revokeAllUserSessions(identity.userId, db);
  });
}

// ───────────── Вход ─────────────
export async function login(
  { email, password }: LoginInput,
  ctx: AuthContext,
): Promise<{ user: PublicUser } & IssuedTokens> {
  const identity = await prisma.authIdentity.findUnique({
    where: { provider_providerId: { provider: "EMAIL", providerId: email } },
    include: { user: true },
  });

  let valid = false;
  if (identity?.passwordHash) {
    valid = await verifyPassword(identity.passwordHash, password);
  } else {
    await verifyAgainstDummy(password);
  }
  // одна и та же ошибка для «нет аккаунта» и «неверный пароль»
  if (!identity || !valid) throw new AppError(401, "INVALID_CREDENTIALS");

  return prisma.$transaction(async db => {
    const owner = await lockIdentityOwner(db, identity.userId);
    if (owner?.status !== "ACTIVE" || owner.role !== "USER" || owner.emailLoginDisabled) throw new AppError(403, "ACCOUNT_BLOCKED");
    const current = await db.authIdentity.findUnique({ where: { id: identity.id } });
    if (!current || current.passwordHash !== identity.passwordHash) throw new AppError(401, "INVALID_CREDENTIALS");
    if (current.temporaryPasswordExpiresAt) {
      if (current.temporaryPasswordExpiresAt <= new Date()) throw new AppError(401, "INVALID_CREDENTIALS");
      throw new AppError(403, "TEMPORARY_PASSWORD");
    }
    if (owner.activationRequired) throw new AppError(403, "ACTIVATION_PENDING");
    const tokens = await createSession(owner, { ip: ctx.ip, userAgent: ctx.userAgent }, db);
    return { user: toPublicUser(owner), ...tokens };
  });
}

// ───────────── Сброс пароля ─────────────
export async function forgotPassword({ email }: ForgotPasswordInput, ctx: AuthContext): Promise<void> {
  if (!emailAvailable || !await consumeMailBudget(email, "reset")) return;
  const candidate = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!candidate) return;
  const token = generateToken();
  const issued = await prisma.$transaction(async tx => {
    const user = await lockIdentityOwner(tx, candidate.id);
    if (!user || user.role !== "USER" || user.status !== "ACTIVE" || user.email !== email ||
        !user.emailVerifiedAt || user.emailLoginDisabled) return false;
    // новая ссылка гасит все прежние
    await tx.verificationToken.updateMany({
      where: { userId: user.id, type: "PASSWORD_RESET", usedAt: null },
      data: { usedAt: new Date() },
    });
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);
    await tx.verificationToken.create({
      data: {
        userId: user.id,
        type: "PASSWORD_RESET",
        email,
        tokenHash: sha256(token),
        expiresAt,
      },
    });
    await enqueueMail(tx, resetPasswordMail(email, token), expiresAt);
    return true;
  });
  if (issued && !env.MAIL_QUEUE_KEY) void sendMail(ctx.log, resetPasswordMail(email, token));
}

export async function resetPassword({ token, password }: ResetPasswordInput): Promise<void> {
  const passwordHash = await hashPassword(password);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const record = await tx.verificationToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.type !== "PASSWORD_RESET" || record.usedAt || record.expiresAt <= now) {
      throw new AppError(400, "INVALID_TOKEN");
    }
    const user = await lockIdentityOwner(tx, record.userId);
    if (!user?.email || !user.emailVerifiedAt || user.role !== "USER" || user.status !== "ACTIVE" ||
        user.emailLoginDisabled || record.email && record.email !== user.email) throw new AppError(400, "INVALID_TOKEN");
    const consumed = await tx.verificationToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new AppError(400, "INVALID_TOKEN");

    // upsert: пользователь, пришедший через Google/Telegram, получает вход по паролю
    await tx.authIdentity.upsert({
      where: { userId_provider: { userId: user.id, provider: "EMAIL" } },
      create: { userId: user.id, provider: "EMAIL", providerId: user.email, passwordHash, verifiedAt: now },
      update: { passwordHash, temporaryPasswordExpiresAt: null },
    });
    // после смены пароля все устройства должны войти заново
    await revokeAllUserSessions(user.id, tx);
  });
}

// ───────────── Текущий пользователь ─────────────
export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(401, "UNAUTHENTICATED");
  if (user.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_BLOCKED");
  return toPublicUser(user);
}
