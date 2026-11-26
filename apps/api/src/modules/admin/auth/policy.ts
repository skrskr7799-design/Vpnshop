import type { Prisma } from "@prisma/client";
import { env } from "../../../config/env";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { dbNow } from "../../commerce/offers";
import { writeAudit } from "../admin.audit";

type Db = Prisma.TransactionClient;

export async function lockStaffWrites(db: Db) {
  await db.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(394662, 1)`;
}

export const requiresFactor = (enrolled: boolean) =>
  env.ADMIN_2FA_POLICY === "required" || env.ADMIN_2FA_POLICY === "optional" && enrolled;

export async function policyIsCurrent(db: Db) {
  const settings = await db.adminOperationalSettings.findUnique({ where: { id: "default" }, select: { twoFactorPolicy: true } });
  return !settings?.twoFactorPolicy || settings.twoFactorPolicy === env.ADMIN_2FA_POLICY;
}

export async function assertCurrentPolicy(db: Db) {
  if (!await policyIsCurrent(db)) throw new AppError(401, "UNAUTHENTICATED");
}

export async function synchronizeAdminPolicy() {
  await prisma.$transaction(async db => {
    await lockStaffWrites(db);
    const previous = await db.adminOperationalSettings.findUnique({ where: { id: "default" }, select: { twoFactorPolicy: true } });
    if (previous?.twoFactorPolicy === env.ADMIN_2FA_POLICY) return;
    const now = await dbNow(db);
    await db.adminOperationalSettings.upsert({ where: { id: "default" },
      create: { id: "default", twoFactorPolicy: env.ADMIN_2FA_POLICY }, update: { twoFactorPolicy: env.ADMIN_2FA_POLICY } });
    await db.adminSession.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } });
    await db.staffChallenge.updateMany({ where: { consumedAt: null }, data: { consumedAt: now } });
    await writeAudit(db, { actorId: null, action: "admin.2fa.policy", entity: "admin", entityId: "default",
      data: { before: previous?.twoFactorPolicy ?? null, after: env.ADMIN_2FA_POLICY } });
  });
}
