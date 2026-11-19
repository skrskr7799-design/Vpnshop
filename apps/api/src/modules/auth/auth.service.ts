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
import { createSession, revokeAllUserSessions, type IssuedTokens } from "./session.service";

export type AuthContext = { log: FastifyBaseLogger; ip?: string; userAgent?: string };

const HOUR_MS = 60 * 60 * 1000;

export const toPublicUser = (user: Pick<User, "id" | "email" | "role">): PublicUser => ({
  id: user.id,
  email: user.email,
  role: user.role,
});

// ───────────── Регистрация ─────────────
// Всегда отвечает одинаково (наружу ничего не утекает): есть такой аккаунт или нет,
// узнать можно только из письма на этот адрес.
export async function register({ email, password }: RegisterInput, ctx: AuthContext): Promise<void> {
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
    void sendMail(ctx.log, accountExistsMail(email));
    return;
  }

  const recent = await prisma.pendingRegistration.count({
    where: { email, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
  });
  if (recent >= MAX_MAILS_PER_EMAIL_PER_HOUR) return;

  const token = generateToken();
  await prisma.pendingRegistration.create({
    data: { email, passwordHash, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + VERIFY_TTL_MS) },
  });
  void sendMail(ctx.log, verifyEmailMail(email, token));
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

  if (identity.user.status !== "ACTIVE") throw new AppError(403, "ACCOUNT_BLOCKED");

  const tokens = await createSession(identity.user, { ip: ctx.ip, userAgent: ctx.userAgent });
  return { user: toPublicUser(identity.user), ...tokens };
}

// ───────────── Сброс пароля ─────────────
export async function forgotPassword({ email }: ForgotPasswordInput, ctx: AuthContext): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "ACTIVE") return;

  const recent = await prisma.verificationToken.count({
    where: { userId: user.id, type: "PASSWORD_RESET", createdAt: { gt: new Date(Date.now() - HOUR_MS) } },
  });
  if (recent >= MAX_MAILS_PER_EMAIL_PER_HOUR) return;

  const token = generateToken();
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // новая ссылка гасит все прежние
    await tx.verificationToken.updateMany({
      where: { userId: user.id, type: "PASSWORD_RESET", usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.verificationToken.create({
      data: {
        userId: user.id,
        type: "PASSWORD_RESET",
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
  });
  void sendMail(ctx.log, resetPasswordMail(email, token));
}

export async function resetPassword({ token, password }: ResetPasswordInput): Promise<void> {
  const passwordHash = await hashPassword(password);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const record = await tx.verificationToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.type !== "PASSWORD_RESET" || record.usedAt || record.expiresAt <= now) {
      throw new AppError(400, "INVALID_TOKEN");
    }
    const consumed = await tx.verificationToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new AppError(400, "INVALID_TOKEN");

    const user = await tx.user.findUniqueOrThrow({ where: { id: record.userId } });
    if (!user.email) throw new AppError(400, "INVALID_TOKEN");

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
