import { AppError } from "../../lib/errors";
import type { DesiredAssignment, JobStatus, PanelBinding, Prisma } from "@prisma/client";
import { dbNow } from "../commerce/offers";
import type { PanelUser } from "../remnawave/remnawave.assignment";
import { lockSubscription, subscriptionTransaction, type Db } from "../subscriptions/store";
import { acquireLease, LeaseLost, leaseOwnership, type OwnedLease } from "./fulfillment.queue";

export type RevisionJob = OwnedLease & {
  assignmentId: string; subscriptionId: string; revision: number; attempts: number; verificationEpoch: number;
};

export class Superseded extends Error {}
export class RevisionReview extends Error {}
export class LeaseWindowTooShort extends Error {}

const markRevisionWriter = (db: Db) => db.$queryRaw`SELECT set_config('vpnshop.fulfillment_writer', 'revision-v1', true)`;
const maxWrites = 6;
export const driftIntervalMs = 60_000;

export async function claimRevision(owner: string, leaseMs: number) {
  return subscriptionTransaction(async db => {
    const [row] = await db.$queryRaw<Omit<RevisionJob, "owner" | "generation">[]>`
      SELECT j.id, j."assignmentId", j.attempts, j."verificationEpoch", a.revision,
             s.id AS "subscriptionId", s."userId"
      FROM "FulfillmentJob" j JOIN "DesiredAssignment" a ON a.id = j."assignmentId"
      JOIN "Subscription" s ON s.id = a."subscriptionId" AND s.revision = a.revision
      LEFT JOIN "FulfillmentLease" l ON l."userId" = s."userId"
      WHERE NOT s."legacyUnverified"
        AND (l."jobId" IS NULL OR l."expiresAt" <= clock_timestamp())
        AND (j.status = 'RUNNING' OR (j.status IN ('PENDING','CONFIRMED','VERIFY_PENDING','RETRY_WAIT')
          AND j."nextAttemptAt" <= (clock_timestamp() AT TIME ZONE 'UTC')))
      ORDER BY j."nextAttemptAt", j.id LIMIT 1 FOR UPDATE OF s, j SKIP LOCKED`;
    if (!row) return null;
    const lease = await acquireLease(db, row.userId, row.id, owner, leaseMs, true);
    if (!lease) return null;
    await markRevisionWriter(db);
    await db.$executeRaw`UPDATE "FulfillmentJob" j SET status = 'SUPERSEDED', "lockedAt" = NULL
      FROM "DesiredAssignment" a WHERE a.id = j."assignmentId" AND a."subscriptionId" = ${row.subscriptionId}
        AND a.revision < ${row.revision} AND j.status <> 'SUPERSEDED'`;
    const now = await dbNow(db);
    await db.fulfillmentJob.update({ where: { id: row.id }, data: {
      status: "RUNNING", attempts: { increment: 1 }, lockedAt: now,
    } });
    return { ...row, attempts: row.attempts + 1, owner, generation: lease.generation };
  });
}

export function guardedRevision<T>(job: RevisionJob, budgetMs: number,
  operation: (db: Db, desired: DesiredAssignment, now: Date) => Promise<T>) {
  return subscriptionTransaction(async db => {
    const subscription = await lockSubscription(db, job.userId);
    const [lease] = await db.$queryRaw<{ enough: boolean }[]>`
      SELECT "expiresAt" > clock_timestamp() + ${budgetMs} * interval '1 millisecond' AS enough
      FROM "FulfillmentLease" WHERE ${leaseOwnership(job)} FOR UPDATE`;
    if (!lease) throw new LeaseLost();
    if (!lease.enough) throw new LeaseWindowTooShort();
    if (subscription?.id !== job.subscriptionId || subscription.revision !== job.revision ||
        subscription.legacyUnverified) throw new Superseded();
    const allocation = { include: { capture: { include: { account: true } } } } as const;
    const desired = await db.desiredAssignment.findUniqueOrThrow({ where: { id: job.assignmentId },
      include: { grant: { include: { adjustment: true, allocation, basis: { include: { allocation } } } } },
    });
    const now = await dbNow(db);
    if (subscription.nextBoundaryAt && subscription.nextBoundaryAt <= now) throw new Superseded();
    if (desired.enabled) {
      if (!desired.expiresAt || desired.expiresAt.getTime() <= now.getTime() + budgetMs ||
          await db.serviceHold.findFirst({ where: { subscriptionId: subscription.id, releasedAt: null } })) {
        throw new Superseded();
      }
      const grant = desired.grant;
      const source = grant?.allocation ?? (grant?.incidentId && grant.basis?.subscriptionId === subscription.id
        ? grant.basis.allocation : null);
      if (!grant || source?.capture.account.environment !== "MOCK" ||
          grant.subscriptionId !== subscription.id || grant.deviceLimit !== desired.deviceLimit ||
          grant.startAt > now ||
          (grant.adjustment?.effectiveAt ?? grant.endAt).getTime() !== desired.expiresAt.getTime() ||
          desired.internalSquads.length === 0) {
        throw new RevisionReview("STAGING_TARGET_UNAPPROVED");
      }
    }
    return operation(db, desired, now);
  });
}

export function markDispatch(job: RevisionJob, budgetMs: number, changes: Prisma.PanelBindingUpdateInput = {}) {
  return guardedRevision(job, budgetMs, async db => {
    await markRevisionWriter(db);
    const reserved = await db.fulfillmentJob.updateMany({
      where: { id: job.id, status: "RUNNING", writes: { lt: maxWrites } }, data: { writes: { increment: 1 } },
    });
    if (reserved.count !== 1) throw new RevisionReview("WRITE_BUDGET_EXHAUSTED");
    if (Object.keys(changes).length) {
      await db.panelBinding.update({ where: { subscriptionId: job.subscriptionId }, data: changes });
    }
  });
}

type Outcome = { status: JobStatus; code: string; delayMs: number; observed?: PanelUser | null;
  observedAt?: Date; bindingPatch?: Prisma.PanelBindingUpdateInput };

export async function settleRevision(job: RevisionJob, panelInstance: string, result: Outcome) {
  return subscriptionTransaction(async db => {
    const subscription = await lockSubscription(db, job.userId);
    const released = await db.$executeRaw`UPDATE "FulfillmentLease" SET "jobId" = NULL, owner = NULL, "expiresAt" = NULL
      WHERE ${leaseOwnership(job)}`;
    if (!released) return false;
    const now = await dbNow(db);
    const stale = subscription?.revision !== job.revision || subscription.id !== job.subscriptionId;
    const row = await db.fulfillmentJob.findUniqueOrThrow({ where: { id: job.id } });
    const requested = row.verificationEpoch !== job.verificationEpoch;
    const refreshed = requested && result.status !== "NEEDS_REVIEW";
    const superseded = stale || result.status === "SUPERSEDED" ||
      (subscription?.nextBoundaryAt && subscription.nextBoundaryAt <= now);
    // If the boundary passed without projection, retry this revision only after refresh.
    const status = stale ? "SUPERSEDED" : superseded || refreshed ? "VERIFY_PENDING" : result.status;
    await markRevisionWriter(db);
    await db.fulfillmentJob.update({ where: { id: job.id }, data: {
      status, nextAttemptAt: new Date(now.getTime() + (refreshed ? 0 : result.delayMs)),
      lastError: status === "CONFIRMED" ? null : superseded ? "REVISION_CHANGED" : refreshed ? "LATE_WRITE_RECHECK" : result.code,
      lockedAt: null, ...(status === "CONFIRMED" && { attempts: 0, completedAt: now }),
    } });
    if (superseded) return false;
    if (result.observed !== undefined) {
      const user = result.observed;
      await db.panelObservation.create({ data: {
        assignmentId: job.assignmentId, panelInstance, revision: job.revision, owner: job.owner, generation: job.generation,
        remoteUserId: user ? BigInt(user.id) : null, status: user?.status, expiresAt: user?.expiresAt,
        deviceLimit: user?.deviceLimit, squads: user?.squads ?? [], comparison: result.code,
        observedAt: result.observedAt ?? now, receivedAt: now,
      } });
    }
    const patch = { ...(refreshed ? {} : result.bindingPatch), ...(status === "CONFIRMED" &&
      { confirmedRevision: job.revision, confirmedAt: now }) };
    if (Object.keys(patch).length) {
      await db.panelBinding.updateMany({ where: { subscriptionId: job.subscriptionId, panelInstance }, data: patch as Prisma.PanelBindingUpdateManyMutationInput });
    }
    return true;
  });
}

// An old HTTP response is only a signal to reread the latest target. It cannot confirm it.
export async function requestRevisionCheck(job: RevisionJob) {
  await subscriptionTransaction(async db => {
    const subscription = await lockSubscription(db, job.userId);
    if (!subscription || subscription.id !== job.subscriptionId) return;
    const desired = await db.desiredAssignment.findUnique({ where: { subscriptionId_revision: {
      subscriptionId: subscription.id, revision: subscription.revision,
    } }, select: { id: true } });
    if (!desired) return;
    await markRevisionWriter(db);
    await db.fulfillmentJob.updateMany({ where: { assignmentId: desired.id }, data: {
      verificationEpoch: { increment: 1 }, nextAttemptAt: await dbNow(db),
    } });
    await db.fulfillmentJob.updateMany({ where: { assignmentId: desired.id, status: "CONFIRMED" },
      data: { status: "VERIFY_PENDING", lastError: "LATE_WRITE_RECHECK" } });
  });
}

export const bindingIdentityMatches = (binding: PanelBinding, user: PanelUser) =>
  Number.isSafeInteger(user.id) && user.id > 0 && user.username === binding.username && user.marker === binding.marker &&
  (binding.remoteUserId === null || BigInt(user.id) === binding.remoteUserId);


// Intent only. The worker retains the lease protocol and rereads before a panel write.
export async function scheduleRevisionVerification(db: Db, userId: string, expectedRevision: number) {
  const subscription = await lockSubscription(db, userId);
  if (!subscription) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND");
  if (subscription.revision !== expectedRevision) throw new AppError(409, "STALE_REVISION");
  const binding = await db.panelBinding.findUnique({ where: { subscriptionId: subscription.id } });
  if (binding?.blockedReason) throw new AppError(409, "BINDING_UNVERIFIED");
  const target = await db.desiredAssignment.findUnique({ where: { subscriptionId_revision: {
    subscriptionId: subscription.id, revision: subscription.revision,
  } }, include: { job: true } });
  if (!target?.job) throw new AppError(404, "NOT_FOUND");
  const now = await dbNow(db);
  const [lease] = await db.$queryRaw<{ expiresAt: Date | null }[]>`
    SELECT "expiresAt" FROM "FulfillmentLease" WHERE "userId" = ${userId} FOR UPDATE`;
  if (lease?.expiresAt && lease.expiresAt > now) throw new AppError(409, "LEASED");
  await markRevisionWriter(db);
  await db.fulfillmentJob.update({ where: { id: target.job.id }, data: {
    status: "VERIFY_PENDING", verificationEpoch: { increment: 1 }, nextAttemptAt: now, lastError: "OPERATOR_VERIFY",
  } });
  return { id: target.job.id, revision: subscription.revision, status: "VERIFY_PENDING" };
}
