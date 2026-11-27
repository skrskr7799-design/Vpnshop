import { randomBytes } from "node:crypto";
import type { AdminTotp, Prisma, User } from "@prisma/client";
import { env } from "../../../config/env";
import { generateToken, sha256 } from "../../../lib/crypto";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { decrypt, encrypt } from "../../../lib/secret-box";
import { lockIdentityOwner } from "../../auth/session.service";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "../../auth/password";
import { dbNow } from "../../commerce/offers";
import { writeAudit } from "../admin.audit";
import { totpEncryptionKey } from "../admin.keys";
import { isAdminRole, type AdminRole } from "../admin.permissions";
import { createAdminSession, revokeAdminSession, type SessionMeta } from "./admin-session.service";
import { assertCurrentPolicy, lockStaffWrites, requiresFactor } from "./policy";
import { generateTotpSecret, totpUri, verifyTotp } from "./totp";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60_000;
const STAGE_TTL = 5 * 60_000;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
type Db = Prisma.TransactionClient;

export { lockStaffWrites } from "./policy";
export const TEMPORARY_PASSWORD_MS = 24 * 60 * 60_000;

export type LoginResult = { step: "change_password" | "enroll_2fa" | "verify_2fa"; stageToken: string }
  | { step: "authenticated"; sessionToken: string; expiresAt: Date };

export async function issueStaffStage(db: Db, userId: string, version: number, stage: "verify" | "enroll" | "password", now: Date) {
  const token = generateToken();
  await db.staffChallenge.create({ data: {
    id: sha256(token), stage, userId, version, expiresAt: new Date(+now + STAGE_TTL), policy: env.ADMIN_2FA_POLICY,
  } });
  return token;
}

async function nextLoginStep(db: Db, user: User, credential: { version: number; temporaryUntil: Date | null },
  ctx: SessionMeta, now: Date): Promise<LoginResult> {
  if (credential.temporaryUntil) return { step: "change_password",
    stageToken: await issueStaffStage(db, user.id, credential.version, "password", now) };
  const enrolled = !!await db.adminTotp.findFirst({ where: { userId: user.id, confirmedAt: { not: null } } });
  if (!requiresFactor(enrolled)) return { step: "authenticated", ...await issueSession(db, user, ctx, now, false) };
  return { step: enrolled ? "verify_2fa" : "enroll_2fa",
    stageToken: await issueStaffStage(db, user.id, credential.version, enrolled ? "verify" : "enroll", now) };
}

export async function adminLogin({ username, password }: { username: string; password: string }, ctx: SessionMeta): Promise<LoginResult> {
  const before = await prisma.staffCredential.findUnique({ where: { username } });
  const valid = before ? await verifyPassword(before.passwordHash, password) : (await verifyAgainstDummy(password), false);
  if (!before || !valid) {
    await writeAudit(prisma, { actorId: before?.userId ?? null, action: "admin.login.failed", entity: "admin", ip: ctx.ip });
    throw new AppError(401, "INVALID_CREDENTIALS");
  }
  const result = await prisma.$transaction(async db => {
    await lockStaffWrites(db);
    await assertCurrentPolicy(db);
    const owner = await lockIdentityOwner(db, before.userId);
    const credential = await db.staffCredential.findUnique({ where: { userId: before.userId } });
    const now = await dbNow(db);
    if (!owner || owner.status !== "ACTIVE" || !isAdminRole(owner.role) || !credential || credential.deactivatedAt ||
        credential.version !== before.version || credential.username !== username ||
        credential.temporaryUntil && credential.temporaryUntil <= now) {
      await writeAudit(db, { actorId: before.userId, action: "admin.login.failed", entity: "admin", ip: ctx.ip });
      return null;
    }
    await writeAudit(db, { actorId: owner.id, action: "admin.login.password_ok", entity: "admin", ip: ctx.ip });
    return nextLoginStep(db, owner, credential, ctx, now);
  });
  if (!result) throw new AppError(401, "INVALID_CREDENTIALS");
  return result;
}

async function stageIn(db: Db, token: string, stage: string) {
  await lockStaffWrites(db);
  await assertCurrentPolicy(db);
  const id = sha256(token);
  const before = await db.staffChallenge.findUnique({ where: { id } });
  if (!before) throw new AppError(401, "INVALID_STAGE");
  const user = await lockIdentityOwner(db, before.userId);
  const challenge = await db.staffChallenge.findUnique({ where: { id } });
  const credential = await db.staffCredential.findUnique({ where: { userId: before.userId } });
  const now = await dbNow(db);
  if (!user || user.status !== "ACTIVE" || !isAdminRole(user.role) || !challenge ||
      challenge.stage !== stage || challenge.consumedAt || challenge.expiresAt <= now ||
      challenge.policy !== env.ADMIN_2FA_POLICY || !credential || credential.deactivatedAt ||
      credential.version !== challenge.version ||
      (stage === "password" ? !credential.temporaryUntil || credential.temporaryUntil <= now : !!credential.temporaryUntil)) throw new AppError(401, "INVALID_STAGE");
  return { user, challenge, credential, now };
}

export function startEnrollment(stageToken: string) {
  return prisma.$transaction(async db => {
    const { user, credential } = await stageIn(db, stageToken, "enroll");
    const existing = await db.adminTotp.findUnique({ where: { userId: user.id } });
    if (existing?.confirmedAt) throw new AppError(409, "ALREADY_ENROLLED");
    const secret = existing ? decrypt(existing.secretEnc, totpEncryptionKey()) : generateTotpSecret();
    if (!existing) await db.adminTotp.create({ data: { userId: user.id, secretEnc: encrypt(secret, totpEncryptionKey()) } });
    return { secret, otpauthUri: totpUri(secret, credential.username) };
  });
}

export async function acceptStaffTotp(db: Db, totp: AdminTotp, code: string, now: Date) {
  if (totp.lockedUntil && totp.lockedUntil > now) throw new AppError(429, "ACCOUNT_LOCKED");
  const step = verifyTotp(decrypt(totp.secretEnc, totpEncryptionKey()), code, +now);
  const accepted = step === null ? 0 : (await db.adminTotp.updateMany({
    where: { id: totp.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
    data: { lastUsedStep: step, failedAttempts: 0, lockedUntil: null },
  })).count;
  if (!accepted) await recordFailure(db, totp, now);
  return accepted === 1;
}

async function recordFailure(db: Db, totp: AdminTotp, now: Date) {
  const attempts = totp.failedAttempts + 1;
  await db.adminTotp.update({ where: { id: totp.id }, data: attempts >= MAX_FAILED_ATTEMPTS
    ? { failedAttempts: 0, lockedUntil: new Date(+now + LOCK_MS) } : { failedAttempts: attempts } });
  await writeAudit(db, { actorId: totp.userId, action: "admin.2fa.failed", entity: "admin", entityId: totp.userId });
}

const normalize = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();
function generateRecoveryCode() {
  const chars = Array.from(randomBytes(10), byte => RECOVERY_ALPHABET[byte & 31]).join("");
  return chars.slice(0, 5) + "-" + chars.slice(5);
}

export async function confirmEnrollment(stageToken: string, code: string, ctx: SessionMeta, time?: Date) {
  const result = await prisma.$transaction(async db => {
    const { user, challenge, now } = await stageIn(db, stageToken, "enroll");
    const totp = await db.adminTotp.findUnique({ where: { userId: user.id } });
    if (!totp || totp.confirmedAt) throw new AppError(400, "ENROLLMENT_NOT_STARTED");
    if (!await acceptStaffTotp(db, totp, code, time ?? now)) return null;
    await db.adminTotp.update({ where: { userId: user.id }, data: { confirmedAt: now } });
    await db.staffChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
    const recoveryCodes = Array.from({ length: 10 }, generateRecoveryCode);
    await db.adminRecoveryCode.deleteMany({ where: { userId: user.id } });
    await db.adminRecoveryCode.createMany({
      data: recoveryCodes.map(code => ({ userId: user.id, codeHash: sha256(normalize(code)) })),
    });
    await writeAudit(db, { actorId: user.id, action: "admin.2fa.enrolled", entity: "admin", entityId: user.id, ip: ctx.ip });
    await db.adminSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } });
    await db.staffChallenge.updateMany({ where: { userId: user.id, consumedAt: null }, data: { consumedAt: now } });
    const session = await issueSession(db, user, ctx, time ?? now, true);
    return { ...session, recoveryCodes };
  });
  if (!result) throw new AppError(401, "INVALID_CODE");
  return result;
}

export async function verifySecondFactor(stageToken: string, input: { code?: string; recoveryCode?: string },
  ctx: SessionMeta, time?: Date) {
  const result = await prisma.$transaction(async db => {
    const { user, challenge, now } = await stageIn(db, stageToken, "verify");
    const totp = await db.adminTotp.findUnique({ where: { userId: user.id } });
    if (!totp?.confirmedAt) throw new AppError(401, "INVALID_STAGE");
    const at = time ?? now;
    if (totp.lockedUntil && totp.lockedUntil > at) throw new AppError(429, "ACCOUNT_LOCKED");
    let recoveryCodesLeft: number | undefined;
    if (input.recoveryCode) {
      const { count } = await db.adminRecoveryCode.updateMany({
        where: { userId: user.id, codeHash: sha256(normalize(input.recoveryCode)), usedAt: null }, data: { usedAt: at },
      });
      if (!count) { await recordFailure(db, totp, at); return null; }
      recoveryCodesLeft = await db.adminRecoveryCode.count({ where: { userId: user.id, usedAt: null } });
      await db.adminTotp.update({ where: { id: totp.id }, data: { failedAttempts: 0, lockedUntil: null } });
      await writeAudit(db, { actorId: user.id, action: "admin.login.recovery_code", entity: "admin", ip: ctx.ip });
    } else if (!await acceptStaffTotp(db, totp, input.code ?? "", at)) return null;
    await db.staffChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
    return { ...await issueSession(db, user, ctx, at, true), recoveryCodesLeft };
  });
  if (!result) throw new AppError(401, "INVALID_CODE");
  return result;
}

async function issueSession(db: Db, user: User, ctx: SessionMeta, at: Date, factorVerified: boolean) {
  const result = await createAdminSession(user.id, ctx, at, db, factorVerified);
  await db.staffCredential.update({ where: { userId: user.id }, data: { lastLoginAt: at } });
  await writeAudit(db, { actorId: user.id, role: user.role, action: "admin.login", entity: "admin", entityId: user.id, ip: ctx.ip });
  return { sessionToken: result.token, expiresAt: result.expiresAt };
}

export async function logoutAdmin(token: string, actorId: string | null, ip?: string) {
  await prisma.$transaction(async db => {
    await lockStaffWrites(db);
    await revokeAdminSession(token, db);
    if (actorId) await writeAudit(db, { actorId, action: "admin.logout", entity: "admin", entityId: actorId, ip });
  });
}

export async function changeTemporaryStaffPassword(stageToken: string, password: string, ctx: SessionMeta) {
  const before = await prisma.staffChallenge.findUnique({ where: { id: sha256(stageToken) }, select: { userId: true } });
  const known = before && await prisma.staffCredential.findUnique({ where: { userId: before.userId } });
  if (!known) throw new AppError(401, "INVALID_STAGE");
  if (await verifyPassword(known.passwordHash, password)) throw new AppError(400, "PASSWORD_MUST_CHANGE");
  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async db => {
    const { user, credential, now } = await stageIn(db, stageToken, "password");
    if (credential.version !== known.version) throw new AppError(401, "INVALID_STAGE");
    await invalidateStaff(db, user.id, now);
    const current = await db.staffCredential.update({ where: { userId: user.id }, data: { passwordHash, temporaryUntil: null } });
    await writeAudit(db, { actorId: user.id, role: user.role, action: "staff.password.changed", entity: "staff", entityId: user.id });
    return nextLoginStep(db, user, current, ctx, now);
  });
}

export async function createStaffAccount(db: Db, input: {
  username: string; passwordHash: string; role: AdminRole; displayName?: string; contactEmail?: string;
  temporaryUntil?: Date;
}) {
  const { role, ...credential } = input;
  return db.user.create({ data: { role, staffCredential: { create: credential } }, select: { id: true, role: true } });
}

export async function invalidateStaff(db: Db, userId: string, now: Date, resetFactor = false) {
  await db.staffCredential.update({ where: { userId }, data: { version: { increment: 1 } } });
  await db.adminSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  await db.staffChallenge.updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: now } });
  if (resetFactor) {
    await db.adminRecoveryCode.deleteMany({ where: { userId } });
    await db.adminTotp.deleteMany({ where: { userId } });
  }
}
