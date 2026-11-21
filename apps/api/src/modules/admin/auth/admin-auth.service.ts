import { randomBytes } from "node:crypto";
import type { UserRole } from "@prisma/client";
import { sha256 } from "../../../lib/crypto";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { decrypt, encrypt } from "../../../lib/secret-box";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../auth/password";
import { writeAudit } from "../admin.audit";
import { totpEncryptionKey } from "../admin.keys";
import { isAdminRole } from "../admin.permissions";
import { createAdminSession, revokeAdminSession, revokeAllAdminSessions, type SessionMeta } from "./admin-session.service";
import { signStageToken, verifyStageToken } from "./stage-token";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60_000;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих символов, 32 знака = 5 бит на символ

export type AdminAuthContext = SessionMeta;
export type LoginStep = "verify_2fa" | "enroll_2fa";

// ───────────── Шаг 1: пароль ─────────────
export async function adminLogin(
  { email, password }: { email: string; password: string },
  ctx: AdminAuthContext,
): Promise<{ step: LoginStep; stageToken: string }> {
  const identity = await prisma.authIdentity.findUnique({
    where: { provider_providerId: { provider: "EMAIL", providerId: email } },
    include: { user: true },
  });

  let valid = false;
  if (identity?.passwordHash) valid = await verifyPassword(identity.passwordHash, password);
  else await verifyAgainstDummy(password); // та же работа, что и для существующего аккаунта

  // Одна и та же ошибка для «нет аккаунта», «неверный пароль», «не админ» и «заблокирован»
  const eligible = identity && valid && identity.user.status === "ACTIVE" && isAdminRole(identity.user.role);
  if (!eligible) {
    await writeAudit(prisma, {
      actorId: identity?.userId ?? null,
      action: "admin.login.failed",
      entity: "admin",
      data: { email: email.slice(0, 254) },
      ip: ctx.ip,
    });
    throw new AppError(401, "INVALID_CREDENTIALS");
  }

  const totp = await prisma.adminTotp.findUnique({ where: { userId: identity.userId } });
  const enrolled = Boolean(totp?.confirmedAt);
  await writeAudit(prisma, { actorId: identity.userId, action: "admin.login.password_ok", entity: "admin", ip: ctx.ip });
  return {
    step: enrolled ? "verify_2fa" : "enroll_2fa",
    stageToken: await signStageToken(identity.userId, enrolled ? "verify" : "enroll"),
  };
}

// ───────────── Подключение 2FA (первый вход) ─────────────
export async function startEnrollment(stageToken: string): Promise<{ secret: string; otpauthUri: string }> {
  const userId = await verifyStageToken(stageToken, "enroll");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const existing = await prisma.adminTotp.findUnique({ where: { userId } });
  if (existing?.confirmedAt) throw new AppError(409, "ALREADY_ENROLLED");

  const secret = generateTotpSecret();
  const data = { secretEnc: encrypt(secret, totpEncryptionKey()), confirmedAt: null, lastUsedStep: null, failedAttempts: 0, lockedUntil: null };
  await prisma.adminTotp.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  return { secret, otpauthUri: totpUri(secret, user.email ?? user.id) };
}

export async function confirmEnrollment(
  stageToken: string,
  code: string,
  ctx: AdminAuthContext,
  now: Date = new Date(),
): Promise<{ sessionToken: string; expiresAt: Date; recoveryCodes: string[] }> {
  const userId = await verifyStageToken(stageToken, "enroll");
  const totp = await prisma.adminTotp.findUnique({ where: { userId } });
  if (!totp || totp.confirmedAt) throw new AppError(400, "ENROLLMENT_NOT_STARTED");
  assertNotLocked(totp.lockedUntil, now);

  const step = verifyTotp(decrypt(totp.secretEnc, totpEncryptionKey()), code, now.getTime());
  if (step === null) {
    await registerFailure(totp.id, now);
    throw new AppError(401, "INVALID_CODE");
  }

  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await prisma.$transaction(async (tx) => {
    await tx.adminTotp.update({
      where: { userId },
      data: { confirmedAt: now, lastUsedStep: step, failedAttempts: 0, lockedUntil: null },
    });
    await tx.adminRecoveryCode.deleteMany({ where: { userId } });
    await tx.adminRecoveryCode.createMany({ data: recoveryCodes.map((c) => ({ userId, codeHash: sha256(normalizeRecoveryCode(c)) })) });
    await writeAudit(tx, { actorId: userId, action: "admin.2fa.enrolled", entity: "admin", entityId: userId, ip: ctx.ip });
  });

  const session = await createAdminSession(userId, ctx, now);
  await writeAudit(prisma, { actorId: userId, action: "admin.login", entity: "admin", entityId: userId, ip: ctx.ip });
  return { sessionToken: session.token, expiresAt: session.expiresAt, recoveryCodes };
}

// ───────────── Шаг 2: второй фактор ─────────────
export async function verifySecondFactor(
  stageToken: string,
  input: { code?: string; recoveryCode?: string },
  ctx: AdminAuthContext,
  now: Date = new Date(),
): Promise<{ sessionToken: string; expiresAt: Date; recoveryCodesLeft?: number }> {
  const userId = await verifyStageToken(stageToken, "verify");
  const totp = await prisma.adminTotp.findUnique({ where: { userId } });
  if (!totp?.confirmedAt) throw new AppError(401, "INVALID_STAGE");
  assertNotLocked(totp.lockedUntil, now);

  let recoveryCodesLeft: number | undefined;
  if (input.recoveryCode) {
    const used = await consumeRecoveryCode(userId, input.recoveryCode, now);
    if (!used) return failSecondFactor(totp.id, userId, ctx, now);
    recoveryCodesLeft = await prisma.adminRecoveryCode.count({ where: { userId, usedAt: null } });
    await prisma.adminTotp.update({ where: { id: totp.id }, data: { failedAttempts: 0, lockedUntil: null } });
    await writeAudit(prisma, { actorId: userId, action: "admin.login.recovery_code", entity: "admin", entityId: userId, data: { left: recoveryCodesLeft }, ip: ctx.ip });
  } else {
    const step = verifyTotp(decrypt(totp.secretEnc, totpEncryptionKey()), input.code ?? "", now.getTime());
    if (step === null) return failSecondFactor(totp.id, userId, ctx, now);

    // Код принимается один раз: шаг должен быть строго больше последнего использованного.
    // Условное обновление атомарно, поэтому два параллельных запроса с одним кодом не пройдут оба.
    const accepted = await prisma.adminTotp.updateMany({
      where: { id: totp.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step, failedAttempts: 0, lockedUntil: null },
    });
    if (accepted.count !== 1) return failSecondFactor(totp.id, userId, ctx, now);
  }

  const session = await createAdminSession(userId, ctx, now);
  await writeAudit(prisma, { actorId: userId, action: "admin.login", entity: "admin", entityId: userId, ip: ctx.ip });
  return { sessionToken: session.token, expiresAt: session.expiresAt, recoveryCodesLeft };
}

export async function logoutAdmin(token: string, actorId: string | null, ip?: string): Promise<void> {
  await revokeAdminSession(token);
  if (actorId) await writeAudit(prisma, { actorId, action: "admin.logout", entity: "admin", entityId: actorId, ip });
}

// ───────────── Управление админами (CLI) ─────────────
export async function createAdminUser(
  { email, password, role }: { email: string; password: string; role: Extract<UserRole, "ADMIN" | "SUPPORT"> },
): Promise<{ userId: string; created: boolean }> {
  if (password.length < 12) throw new Error("Пароль админа должен быть не короче 12 символов");
  const passwordHash = await hashPassword(password);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email } });
    const user = existing
      ? await tx.user.update({ where: { id: existing.id }, data: { role, status: "ACTIVE" } })
      : await tx.user.create({ data: { email, emailVerifiedAt: now, role } });
    await tx.authIdentity.upsert({
      where: { userId_provider: { userId: user.id, provider: "EMAIL" } },
      create: { userId: user.id, provider: "EMAIL", providerId: email, passwordHash, verifiedAt: now },
      update: { passwordHash },
    });
    await writeAudit(tx, { actorId: null, action: existing ? "admin.promote" : "admin.create", entity: "user", entityId: user.id, data: { role } });
    return { userId: user.id, created: !existing };
  });
}

// Потеряны и телефон, и резервные коды: сброс второго фактора. Админ пройдёт подключение заново.
export async function resetAdminTotp(email: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return false;
  await prisma.$transaction(async (tx) => {
    await tx.adminTotp.deleteMany({ where: { userId: user.id } });
    await tx.adminRecoveryCode.deleteMany({ where: { userId: user.id } });
    await writeAudit(tx, { actorId: null, action: "admin.2fa.reset", entity: "admin", entityId: user.id });
  });
  await revokeAllAdminSessions(user.id);
  return true;
}

// ───────────── внутреннее ─────────────
function assertNotLocked(lockedUntil: Date | null, now: Date): void {
  if (lockedUntil && lockedUntil > now) throw new AppError(429, "ACCOUNT_LOCKED");
}

// 5 неверных кодов подряд блокируют ввод на 15 минут (шестизначный код иначе подбирается)
async function registerFailure(totpId: string, now: Date): Promise<void> {
  const updated = await prisma.adminTotp.update({ where: { id: totpId }, data: { failedAttempts: { increment: 1 } } });
  if (updated.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    await prisma.adminTotp.update({
      where: { id: totpId },
      data: { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) },
    });
  }
}

async function failSecondFactor(totpId: string, userId: string, ctx: AdminAuthContext, now: Date): Promise<never> {
  await registerFailure(totpId, now);
  await writeAudit(prisma, { actorId: userId, action: "admin.2fa.failed", entity: "admin", entityId: userId, ip: ctx.ip });
  throw new AppError(401, "INVALID_CODE");
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b & 31]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

const normalizeRecoveryCode = (code: string): string => code.replace(/[\s-]/g, "").toUpperCase();

async function consumeRecoveryCode(userId: string, code: string, now: Date): Promise<boolean> {
  // Условное обновление: один код нельзя использовать дважды даже при параллельных запросах
  const { count } = await prisma.adminRecoveryCode.updateMany({
    where: { userId, codeHash: sha256(normalizeRecoveryCode(code)), usedAt: null },
    data: { usedAt: now },
  });
  return count === 1;
}

