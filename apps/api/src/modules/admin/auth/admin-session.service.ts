import type { Prisma } from "@prisma/client";
import { env } from "../../../config/env";
import { generateToken, sha256 } from "../../../lib/crypto";
import { prisma } from "../../../lib/prisma";
import { policyIsCurrent, requiresFactor } from "./policy";
import { isAdminRole, type AdminRole } from "../admin.permissions";

// Сессии серверные: в куке только случайный токен, в БД его хэш.
// Поэтому отзыв сессии, блокировка админа и смена роли действуют мгновенно.
const TOUCH_INTERVAL_MS = 60_000;

const ttlMs = () => env.ADMIN_SESSION_HOURS * 3_600_000;
const idleMs = () => env.ADMIN_IDLE_MINUTES * 60_000;

export type AdminContext = { userId: string; email: string | null; username: string; requiresTotp: boolean; enrolled: boolean; credentialVersion: number; role: AdminRole; sessionId: string };
export type SessionMeta = { ip?: string; userAgent?: string };

export async function createAdminSession(
  userId: string,
  meta: SessionMeta,
  now: Date = new Date(),
  db: Prisma.TransactionClient = prisma,
  factorVerified = false,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + ttlMs());
  await db.adminSession.create({
    data: {
      userId,
      tokenHash: sha256(token),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 255),
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + idleMs()),
      expiresAt, policy: env.ADMIN_2FA_POLICY, factorVerified,
    },
  });
  return { token, expiresAt };
}

export async function resolveAdminSession(token: string, now: Date = new Date(), touch = true): Promise<AdminContext | null> {
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, role: true, status: true, totp: { select: { confirmedAt: true } }, staffCredential: {
      select: { username: true, version: true, contactEmail: true, temporaryUntil: true, deactivatedAt: true },
    } } } },
  });
  if (!session || session.revokedAt || session.expiresAt <= now || session.idleExpiresAt <= now) return null;
  // Роль и статус проверяются при каждом запросе
  const credential = session.user.staffCredential;
  const requiresTotp = requiresFactor(!!session.user.totp?.confirmedAt);
  if (!credential || credential.temporaryUntil || credential.deactivatedAt || session.user.status !== "ACTIVE" ||
      !isAdminRole(session.user.role) || session.policy !== env.ADMIN_2FA_POLICY ||
      requiresTotp && (!session.user.totp?.confirmedAt || !session.factorVerified) || !await policyIsCurrent(prisma)) return null;

  // Скользящее окно бездействия, но не дальше абсолютного предела; пишем не чаще раза в минуту
  if (touch && now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
    const idle = Math.min(now.getTime() + idleMs(), session.expiresAt.getTime());
    await prisma.adminSession.updateMany({
      where: { id: session.id, revokedAt: null, lastSeenAt: session.lastSeenAt },
      data: { lastSeenAt: now, idleExpiresAt: new Date(idle) },
    });
  }
  return { userId: session.user.id, email: credential.contactEmail ?? session.user.email, username: credential.username, requiresTotp, enrolled: !!session.user.totp?.confirmedAt,
    credentialVersion: credential.version, role: session.user.role, sessionId: session.id };
}

export async function revokeAdminSession(token: string, db: Prisma.TransactionClient = prisma): Promise<void> {
  await db.adminSession.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
}
