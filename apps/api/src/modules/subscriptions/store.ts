import type { Prisma, Subscription } from "@prisma/client";
import { stagingPanelSettings } from "../../config/staging-panel";
import { prisma } from "../../lib/prisma";
import { dbNow } from "../commerce/offers";
import { writeAudit } from "../admin/admin.audit";

export type Db = Prisma.TransactionClient;

export async function subscriptionTransaction<T>(operation: (db: Db) => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await prisma.$transaction(operation, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      const dbError = error as { code?: string; meta?: { code?: string } };
      const retryable = dbError?.code === "P2034" ||
        (dbError?.code === "P2010" && ["40001", "40P01"].includes(dbError.meta?.code ?? ""));
      if (!retryable || retry === 2) throw error;
    }
  }
}

export async function lockSubscription(db: Db, userId: string) {
  const [subscription] = await db.$queryRaw<Subscription[]>`
    SELECT * FROM "Subscription" WHERE "userId" = ${userId} FOR UPDATE`;
  return subscription;
}

export async function createSubscription(db: Db, userId: string) {
  const [legacy] = await db.$queryRaw<{ existing: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "User" u WHERE u.id = ${userId} AND u."remnawaveUserId" IS NOT NULL
      UNION ALL SELECT 1 FROM "Order" o WHERE o."userId" = ${userId} AND o.status IN ('PAID','FULFILLED')
        AND NOT EXISTS (SELECT 1 FROM "OrderAllocation" a WHERE a."orderId" = o.id)
    ) AS existing`;
  await db.subscription.createMany({
    data: [{ userId, legacyUnverified: legacy?.existing ?? false }], skipDuplicates: true,
  });
  return (await lockSubscription(db, userId))!;
}

export function auditDecision(db: Db, subscriptionId: string, action: string, data: Prisma.InputJsonObject, actorId: string | null = null) {
  return writeAudit(db, { actorId, action, entity: "subscription", entityId: subscriptionId, data });
}

const instantEquals = (a: Date | null, b: Date | null) => a?.getTime() === b?.getTime();

// Must be called under the subscription row lock.
export async function projectAssignment(db: Db, subscription: Subscription, now: Date, reason: string, force = false) {
  const candidates = await db.periodGrant.findMany({
    where: { subscriptionId: subscription.id, endAt: { gt: now } },
    orderBy: { startAt: "asc" }, include: { adjustment: true },
  });
  const bounds = candidates.flatMap(grant => {
    const end = grant.adjustment?.effectiveAt ?? grant.endAt;
    return end <= now || end <= grant.startAt ? [] : [{ grant, end }];
  });
  const first = bounds[0];
  const active = first && first.grant.startAt <= now ? first : undefined;
  const nextBoundaryAt = active?.end ?? first?.grant.startAt ?? null;
  const held = subscription.legacyUnverified || !!await db.serviceHold.findFirst({
    where: { subscriptionId: subscription.id, releasedAt: null }, select: { id: true },
  });
  const projected = active && !held ? active : null;
  const previous = subscription.revision ? await db.desiredAssignment.findUniqueOrThrow({
    where: { subscriptionId_revision: { subscriptionId: subscription.id, revision: subscription.revision } },
  }) : undefined;
  const data = {
    internalSquads: projected ? stagingPanelSettings()?.REMNAWAVE_STAGING_SQUADS ?? previous?.internalSquads ?? [] : [],
    subscriptionId: subscription.id, enabled: projected !== null,
    grantId: projected?.grant.id ?? null, deviceLimit: projected?.grant.deviceLimit ?? null,
    expiresAt: projected?.end ?? null, nextBoundaryAt,
  };
  if (previous && !force) {
    if (previous.grantId === data.grantId && previous.enabled === data.enabled &&
        previous.deviceLimit === data.deviceLimit && previous.internalSquads.join(",") === data.internalSquads.join(",") &&
        instantEquals(previous.expiresAt, data.expiresAt) &&
        instantEquals(previous.nextBoundaryAt, nextBoundaryAt)) return previous;
  }
  const assignment = await db.desiredAssignment.create({
    data: { ...data, revision: subscription.revision + 1, createdAt: now, reason },
  });
  await db.subscription.update({
    where: { id: subscription.id }, data: { revision: assignment.revision, nextBoundaryAt },
  });
  await db.fulfillmentJob.create({ data: { assignmentId: assignment.id, nextAttemptAt: now } });
  return assignment;
}

// A missed tick projects the current interval directly; history retains earlier revisions.
export async function refreshDueAssignments(limit = 20, recoverPausedAssignments = false) {
  let processed = 0;
  for (; processed < limit; processed++) {
    const changed = await subscriptionTransaction(async db => {
      const [subscription] = await db.$queryRaw<Subscription[]>`
        SELECT s.* FROM "Subscription" s WHERE s."nextBoundaryAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
        OR (${recoverPausedAssignments} AND EXISTS (
          SELECT 1 FROM "DesiredAssignment" a WHERE a."subscriptionId" = s.id AND a.revision = s.revision
            AND a.enabled AND cardinality(a."internalSquads") = 0
        ))
        ORDER BY s."nextBoundaryAt", s.id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!subscription) return false;
      await projectAssignment(db, subscription, await dbNow(db), "PERIOD_BOUNDARY");
      return true;
    });
    if (!changed) break;
  }
  return processed;
}
