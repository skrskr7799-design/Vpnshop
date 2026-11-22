import { randomBytes, randomUUID } from "node:crypto";
import type { AdminTotp, Prisma, User } from "@prisma/client";
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
import { generateTotpSecret, totpUri, verifyTotp } from "./totp";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60_000;
const STAGE_TTL = 5 * 60_000;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
type Db = Prisma.TransactionClient;

export async function lockStaffWrites(db: Db) {
  await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(394662, 1)`;
}

export async function adminLogin({ email, password }: { email: string; password: string }, ctx: SessionMeta) {
  const before = await prisma.user.findUnique({ where: { email }, include: { staffCredential: true } });
  const hash = before?.staffCredential?.passwordHash;
  const valid = hash ? await verifyPassword(hash, password) : (await verifyAgainstDummy(password), false);
  if (!before || !valid) {
    await writeAudit(prisma, { actorId: before?.staffCredential ? before.id : null, action: "admin.login.failed", entity: "admin", ip: ctx.ip });
    throw new AppError(401, "INVALID_CREDENTIALS");
  }
  const result = await prisma.$transaction(async db => {
    const owner = await lockIdentityOwner(db, before.id);
    const credential = await db.staffCredential.findUnique({ where: { userId: before.id } });
    if (!owner || owner.status !== "ACTIVE" || !isAdminRole(owner.role) || !credential || credential.passwordHash !== hash) {
      await writeAudit(db, { actorId: before.id, action: "admin.login.failed", entity: "admin", ip: ctx.ip });
      return null;
    }
    const totp = await db.adminTotp.findUnique({ where: { userId: owner.id } });
    const stage = totp?.confirmedAt ? "verify" : "enroll";
    const token = generateToken();
    const now = await dbNow(db);
    await db.staffChallenge.create({ data: {
      id: sha256(token), stage, userId: owner.id, version: credential.version, expiresAt: new Date(+now + STAGE_TTL),
    } });
    await writeAudit(db, { actorId: owner.id, action: "admin.login.password_ok", entity: "admin", ip: ctx.ip });
    return { step: stage === "enroll" ? "enroll_2fa" as const : "verify_2fa" as const, stageToken: token };
  });
  if (!result) throw new AppError(401, "INVALID_CREDENTIALS");
  return result;
}

async function stageIn(db: Db, token: string, stage: string) {
  const id = sha256(token);
  const before = await db.staffChallenge.findUnique({ where: { id } });
  if (!before) throw new AppError(401, "INVALID_STAGE");
  const user = await lockIdentityOwner(db, before.userId);
  const challenge = await db.staffChallenge.findUnique({ where: { id } });
  const credential = await db.staffCredential.findUnique({ where: { userId: before.userId } });
  const now = await dbNow(db);
  if (!user || user.status !== "ACTIVE" || !isAdminRole(user.role) || !challenge ||
      challenge.stage !== stage || challenge.consumedAt || challenge.expiresAt <= now ||
      credential?.version !== challenge.version) throw new AppError(401, "INVALID_STAGE");
  return { user, challenge, now };
}

export function startEnrollment(stageToken: string) {
  return prisma.$transaction(async db => {
    const { user } = await stageIn(db, stageToken, "enroll");
    const existing = await db.adminTotp.findUnique({ where: { userId: user.id } });
    if (existing?.confirmedAt) throw new AppError(409, "ALREADY_ENROLLED");
    const secret = existing ? decrypt(existing.secretEnc, totpEncryptionKey()) : generateTotpSecret();
    if (!existing) await db.adminTotp.create({ data: { userId: user.id, secretEnc: encrypt(secret, totpEncryptionKey()) } });
    return { secret, otpauthUri: totpUri(secret, user.email ?? user.id) };
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
    const session = await issueSession(db, user, ctx, time ?? now);
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
    return { ...await issueSession(db, user, ctx, at), recoveryCodesLeft };
  });
  if (!result) throw new AppError(401, "INVALID_CODE");
  return result;
}

async function issueSession(db: Db, user: User, ctx: SessionMeta, at: Date) {
  const result = await createAdminSession(user.id, ctx, at, db);
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

export async function createAdminUser({ email, password, role }: { email: string; password: string; role: AdminRole }) {
  if (password.length < 12) throw new Error("Staff passwords require 12 characters");
  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async db => {
    await lockStaffWrites(db);
    if (await db.user.findUnique({ where: { email } })) throw new AppError(409, "STAFF_ADDRESS_IN_USE");
    const user = await db.user.create({ data: { email, emailVerifiedAt: new Date(), role, staffCredential: { create: { passwordHash } } } });
    await writeAudit(db, { actorId: null, action: "admin.bootstrap", entity: "admin", entityId: user.id, data: { role } });
    return { userId: user.id, created: true };
  });
}

export async function invalidateStaff(db: Db, userId: string, now: Date, resetFactor = false) {
  await db.staffCredential.update({ where: { userId }, data: { version: { increment: 1 } } });
  await db.adminSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  if (resetFactor) {
    await db.adminRecoveryCode.deleteMany({ where: { userId } });
    await db.adminTotp.deleteMany({ where: { userId } });
  }
}

export async function resetAdminTotp(email: string) {
  return prisma.$transaction(async db => {
    await lockStaffWrites(db);
    const user = await db.user.findUnique({ where: { email }, include: { staffCredential: true } });
    if (!user || !isAdminRole(user.role) || !user.staffCredential) return false;
    await lockIdentityOwner(db, user.id);
    await invalidateStaff(db, user.id, await dbNow(db), true);
    await writeAudit(db, { actorId: null, action: "admin.break_glass.totp_reset", entity: "admin", entityId: user.id, correlationId: randomUUID() });
    return true;
  });
}
