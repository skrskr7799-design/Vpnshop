import { env } from "../../config/env";
import { enqueueMail } from "../mail/outbox";
import type { FastifyBaseLogger } from "fastify";
import type {
  ForgotPasswordInput,
  LoginInput,
  PublicUser,
  RegisterInput,
  ResetPasswordInput,
} from "@vpn/shared";
import type { User } from "@prisma/client";
import { generateToken, sha256 } from "../../lib/crypto";
import { isUniqueViolation } from "../../lib/db-errors";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { sendMail } from "../mail/mail.service";
import { accountExistsMail, resetPasswordMail, verifyEmailMail } from "../mail/mail.templates";
import { MAX_MAILS_PER_EMAIL_PER_HOUR, RESET_TTL_MS, VERIFY_TTL_MS } from "./auth.constants";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password";
import { createSession, lockIdentityOwner, revokeAllUserSessions, type IssuedTokens } from "./session.service";

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

export const toPublicUser = (user: Pick<User, "id" | "email" | "role">): PublicUser => ({
  id: user.id,
  email: user.email,
  role: user.role,
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
    await enqueueMail(db, mail, expiresAt);
  });
  if (!env.MAIL_QUEUE_KEY) void sendMail(ctx.log, mail);
}

// Аккаунт появляется только здесь, после подтверждения владения почтой.
export async function verifyEmail(token: string): Promise<void> {
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const pending = await tx.pendingRegistration.findUnique({ where: { tokenHash: sha256(token) } });
      if (!pending || pending.expiresAt <= now) throw new AppError(400, "INVALID_TOKEN");

      // атомарно «съедаем» заявку: повторный клик по ссылке ничего не создаст
      const taken = await tx.pendingRegistration.deleteMany({ where: { id: pending.id } });
      if (taken.count !== 1) throw new AppError(400, "INVALID_TOKEN");

      await tx.user.create({
        data: {
          email: pending.email,
          emailVerifiedAt: now,
          identities: {
            create: {
              provider: "EMAIL",
              providerId: pending.email,
              passwordHash: pending.passwordHash,
              verifiedAt: now,
            },
          },
        },
      });
      // остальные заявки на этот адрес больше не нужны
      await tx.pendingRegistration.deleteMany({ where: { email: pending.email } });
    });
  } catch (err) {
    // аккаунт на этот email успел появиться другим путём
    if (isUniqueViolation(err)) throw new AppError(400, "INVALID_TOKEN");
    throw err;
  }
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
    if (owner?.status !== "ACTIVE" || owner.role !== "USER") throw new AppError(403, "ACCOUNT_BLOCKED");
    const current = await db.authIdentity.findUnique({ where: { id: identity.id } });
    if (!current || current.passwordHash !== identity.passwordHash) throw new AppError(401, "INVALID_CREDENTIALS");
    const tokens = await createSession(owner, { ip: ctx.ip, userAgent: ctx.userAgent }, db);
    return { user: toPublicUser(owner), ...tokens };
  });
}

// ───────────── Сброс пароля ─────────────
export async function forgotPassword({ email }: ForgotPasswordInput, ctx: AuthContext): Promise<void> {
  if (!await consumeMailBudget(email, "reset")) return;
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
        user.emailLoginDisabled) throw new AppError(400, "INVALID_TOKEN");
    const consumed = await tx.verificationToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new AppError(400, "INVALID_TOKEN");

    // upsert: пользователь, пришедший через Google/Telegram, получает вход по паролю
    await tx.authIdentity.upsert({
      where: { userId_provider: { userId: user.id, provider: "EMAIL" } },
      create: { userId: user.id, provider: "EMAIL", providerId: user.email, passwordHash, verifiedAt: now },
      update: { passwordHash },
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
