import type { AuthProvider, Prisma, User } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { generateToken, sha256 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { REFRESH_REUSE_GRACE_MS, REFRESH_TTL_MS } from "./auth.constants";
import { signAccessToken, type AuthClaims } from "./jwt";

export type SessionMeta = { ip?: string; userAgent?: string; loginMethod?: AuthProvider };
export type IssuedTokens = { accessToken: string; refreshToken: string };
type Db = Prisma.TransactionClient;

export async function lockIdentityOwner(db: Db, userId: string) {
  const [user] = await db.$queryRaw<User[]>`SELECT * FROM "User" WHERE id = ${userId} FOR UPDATE`;
  return user;
}

export async function requireLiveFamily(claims: AuthClaims, db: Db = prisma) {
  const family = await db.sessionFamily.findFirst({ where: {
    id: claims.sid, userId: claims.userId, revokedAt: null, expiresAt: { gt: new Date() },
  }, include: { user: true } });
  if (!family) throw new AppError(401, "UNAUTHENTICATED");
  if (family.user.status !== "ACTIVE" || family.user.role !== "USER" || family.user.activationRequired) throw new AppError(403, "ACCOUNT_BLOCKED");
  return family;
}

export async function createSession(user: { id: string }, meta: SessionMeta, db?: Db): Promise<IssuedTokens> {
  async function issue(tx: Db) {
    const owner = await lockIdentityOwner(tx, user.id);
    if (!owner || owner.status !== "ACTIVE" || owner.role !== "USER" || owner.activationRequired) throw new AppError(403, "ACCOUNT_BLOCKED");
    const sid = randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const refreshToken = generateToken();
    const userAgent = meta.userAgent?.slice(0, 200);
    await tx.sessionFamily.create({ data: { id: sid, userId: owner.id, expiresAt, userAgent, loginMethod: meta.loginMethod } });
    await tx.session.create({ data: {
      userId: owner.id, familyId: sid, liveFamilyId: sid, tokenHash: sha256(refreshToken), expiresAt, userAgent, ip: meta.ip,
    } });
    return { accessToken: await signAccessToken({ userId: owner.id, role: owner.role, sid }), refreshToken };
  }
  return db ? issue(db) : prisma.$transaction(issue);
}

export async function rotateSession(refreshToken: string, meta: SessionMeta): Promise<IssuedTokens> {
  const tokenHash = sha256(refreshToken);
  const initial = await prisma.session.findUnique({ where: { tokenHash } });
  if (!initial?.liveFamilyId) throw new AppError(401, "INVALID_SESSION");
  const result = await prisma.$transaction(async db => {
    const owner = await lockIdentityOwner(db, initial.userId);
    const token = await db.session.findUniqueOrThrow({ where: { tokenHash }, include: { family: true } });
    const now = new Date();
    const family = token.family;
    if (!owner || owner.status !== "ACTIVE" || owner.role !== "USER" || owner.activationRequired || !family ||
        family.revokedAt || family.expiresAt <= now || token.expiresAt <= now) return "INVALID_SESSION";
    if (token.revokedAt) {
      if (token.rotatedAt && +now - +token.rotatedAt <= REFRESH_REUSE_GRACE_MS) return "REFRESH_RACE";
      await revokeFamilies(db, owner.id, { id: family.id });
      return "INVALID_SESSION";
    }
    const next = generateToken();
    await db.session.update({ where: { id: token.id }, data: { revokedAt: now, rotatedAt: now } });
    await db.session.create({ data: {
      userId: owner.id, familyId: family.id, liveFamilyId: family.id, tokenHash: sha256(next),
      expiresAt: family.expiresAt, userAgent: meta.userAgent?.slice(0, 200), ip: meta.ip,
    } });
    await db.sessionFamily.update({ where: { id: family.id }, data: { lastSeenAt: now } });
    return { accessToken: await signAccessToken({ userId: owner.id, role: owner.role, sid: family.id }), refreshToken: next };
  });
  if (typeof result === "string") throw new AppError(401, result);
  return result;
}

async function revokeFamilies(db: Db, userId: string, match: Prisma.SessionFamilyWhereInput) {
  const where = { ...match, userId, revokedAt: null };
  const families = await db.sessionFamily.findMany({ where, select: { id: true } });
  const ids = families.map(family => family.id);
  const now = new Date();
  await db.sessionFamily.updateMany({ where, data: { revokedAt: now } });
  await db.session.updateMany({ where: { userId, liveFamilyId: { in: ids }, revokedAt: null }, data: { revokedAt: now } });
  await db.oAuthFlow.deleteMany({ where: { familyId: { in: ids } } });
  await db.identityProof.deleteMany({ where: { familyId: { in: ids } } });
}

export async function revokeSessionFamily(refreshToken: string): Promise<void> {
  const token = await prisma.session.findUnique({ where: { tokenHash: sha256(refreshToken) } });
  if (token?.liveFamilyId) await revokeDevice(token.userId, token.liveFamilyId);
}

export async function revokeDevice(userId: string, sid: string, caller?: AuthClaims) {
  await prisma.$transaction(async db => {
    await lockIdentityOwner(db, userId);
    if (caller) await requireLiveFamily(caller, db);
    if (caller && !await db.sessionFamily.findFirst({ where: { id: sid, userId }, select: { id: true } })) {
      throw new AppError(404, "NOT_FOUND");
    }
    await revokeFamilies(db, userId, { id: sid });
  });
}

export function revokeOtherDevices(claims: AuthClaims, tx?: Db) {
  async function revoke(db: Db) {
    await lockIdentityOwner(db, claims.userId);
    await requireLiveFamily(claims, db);
    await revokeFamilies(db, claims.userId, { id: { not: claims.sid } });
  }
  return tx ? revoke(tx) : prisma.$transaction(revoke);
}

export async function revokeAllUserSessions(userId: string, db: Db = prisma): Promise<void> {
  // Caller owns the User row when composed with password reset.
  await revokeFamilies(db, userId, {});
  await db.session.updateMany({ where: { userId, liveFamilyId: null, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function listDevices(claims: AuthClaims) {
  const rows = await prisma.sessionFamily.findMany({ where: {
    userId: claims.userId, expiresAt: { gt: new Date() }, revokedAt: null,
  }, orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }] });
  return rows.map(({ id, createdAt, lastSeenAt, expiresAt, userAgent }) =>
    ({ id, createdAt, lastSeenAt, expiresAt, device: userAgent ?? "Неизвестное устройство", current: id === claims.sid }));
}

export async function touchFamily(family: { id: string; lastSeenAt: Date }) {
  const now = new Date();
  const threshold = new Date(+now - 5 * 60_000);
  if (family.lastSeenAt < threshold) await prisma.sessionFamily.updateMany({
    where: { id: family.id, revokedAt: null, expiresAt: { gt: now }, lastSeenAt: { lt: threshold } },
    data: { lastSeenAt: now },
  });
}
