import type { Prisma, UserRole } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { generateToken, sha256 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { REFRESH_REUSE_GRACE_MS, REFRESH_TTL_MS } from "./auth.constants";
import { signAccessToken } from "./jwt";

export type SessionMeta = { ip?: string; userAgent?: string };
export type IssuedTokens = { accessToken: string; refreshToken: string };

const newExpiry = () => new Date(Date.now() + REFRESH_TTL_MS);

export async function createSession(
  user: { id: string; role: UserRole },
  meta: SessionMeta,
  familyId: string = randomUUID(),
): Promise<IssuedTokens> {
  const refreshToken = generateToken();
  await prisma.session.create({
    data: {
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 255),
      expiresAt: newExpiry(),
    },
  });
  const accessToken = await signAccessToken({ userId: user.id, role: user.role });
  return { accessToken, refreshToken };
}

// Ротация refresh-токена: старый гасим, выдаём новый в той же «семье».
// Повторное предъявление уже использованного токена (вне окна гонки) трактуем как кражу
// и отзываем всю семью.
export async function rotateSession(refreshToken: string, meta: SessionMeta): Promise<IssuedTokens> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(refreshToken) },
    include: { user: true },
  });
  if (!session) throw new AppError(401, "INVALID_SESSION");

  const now = new Date();

  if (session.revokedAt) {
    if (now.getTime() - session.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS) {
      // две вкладки обновились одновременно: клиент просто повторит запрос с новой кукой
      throw new AppError(401, "REFRESH_RACE");
    }
    await prisma.session.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    throw new AppError(401, "INVALID_SESSION");
  }

  if (session.expiresAt <= now || session.user.status !== "ACTIVE") {
    await prisma.session.updateMany({
      where: { familyId: session.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    throw new AppError(401, "INVALID_SESSION");
  }

  const nextToken = generateToken();
  const rotated = await prisma.$transaction(async (tx) => {
    // атомарно: только один из параллельных запросов сможет погасить этот токен
    const res = await tx.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (res.count !== 1) return false;
    await tx.session.create({
      data: {
        userId: session.userId,
        familyId: session.familyId,
        tokenHash: sha256(nextToken),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 255),
        expiresAt: newExpiry(),
      },
    });
    return true;
  });
  if (!rotated) throw new AppError(401, "REFRESH_RACE");

  const accessToken = await signAccessToken({ userId: session.user.id, role: session.user.role });
  return { accessToken, refreshToken: nextToken };
}

// Выход: гасим всю семью токенов этого устройства.
export async function revokeSessionFamily(refreshToken: string): Promise<void> {
  const session = await prisma.session.findUnique({ where: { tokenHash: sha256(refreshToken) } });
  if (!session) return;
  await prisma.session.updateMany({
    where: { familyId: session.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(userId: string, db: Prisma.TransactionClient = prisma): Promise<void> {
  await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
