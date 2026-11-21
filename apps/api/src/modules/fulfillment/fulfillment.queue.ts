import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { LEGACY_LOCK_TIMEOUT_MS, MAX_ATTEMPTS } from "./fulfillment.constants";

type Db = Prisma.TransactionClient;

export type ClaimedJob = {
  id: string;
  orderId: string;
  attempts: number;
  owner: string;
  generation: bigint;
  targetExpireAt: Date | null;
  order: {
    id: string;
    userId: string;
    status: string;
    durationMonths: number;
    deviceLimit: number;
  };
};

// Вызывается в той же транзакции, где заказ получает статус PAID.
// orderId уникален, поэтому повторный вызов (повторный вебхук) вторую задачу не создаст.
export async function enqueueFulfillment(db: Db, orderId: string): Promise<void> {
  await db.fulfillmentJob.upsert({ where: { orderId }, create: { orderId }, update: {} });
}

export class LeaseLost extends Error {
  constructor() { super("Fulfillment lease expired or reassigned"); }
}

async function markWriter(tx: Db) {
  await tx.$queryRaw`SELECT set_config('vpnshop.fulfillment_writer', 'lease-v1', true)`;
}

export async function claimNextJob(owner: string, leaseMs: number, scheduleTime?: Date): Promise<ClaimedJob | null> {
  if (process.env.NODE_ENV !== "test") return null;
  return prisma.$transaction(async tx => {
    // Lock the account as well as the job. A backdated insert must not start a
    // second order while another order for this account is in flight.
    const [row] = await tx.$queryRaw<(Omit<ClaimedJob, "owner" | "generation"> & { status: string })[]>`
      SELECT j.id, j.status::text, j."orderId", j.attempts, j."targetExpireAt",
             json_build_object('id', o.id, 'userId', u.id, 'status', o.status,
               'durationMonths', o."durationMonths", 'deviceLimit', o."deviceLimit") AS "order"
      FROM "FulfillmentJob" j JOIN "Order" o ON o.id = j."orderId"
      JOIN "User" u ON u.id = o."userId"
      LEFT JOIN "FulfillmentLease" l ON l."userId" = u.id
      WHERE (l."jobId" IS NULL OR (l."jobId" = j.id AND l."expiresAt" <= clock_timestamp()))
        AND (
          (j.status = 'RUNNING' AND (l."jobId" = j.id OR
            COALESCE(j."lockedAt", '-infinity') <= (clock_timestamp() AT TIME ZONE 'UTC') - ${LEGACY_LOCK_TIMEOUT_MS} * interval '1 millisecond'))
          OR (j.status = 'PENDING' AND j."nextAttemptAt" <= COALESCE(${scheduleTime ?? null}::timestamp, statement_timestamp() AT TIME ZONE 'UTC')
            AND NOT EXISTS (
              SELECT 1 FROM "Order" prev JOIN "FulfillmentJob" p ON p."orderId" = prev.id
              WHERE prev."userId" = u.id AND p.id <> j.id AND (p.status = 'RUNNING' OR
                (p.status <> 'DONE' AND (p."createdAt", p.id) < (j."createdAt", j.id)))
            ))
        )
      ORDER BY j."nextAttemptAt", j."createdAt", j.id
      LIMIT 1 FOR UPDATE OF u,j SKIP LOCKED`;
    if (!row) return null;
    const [lease] = await tx.$queryRaw<{ generation: bigint }[]>`
      INSERT INTO "FulfillmentLease" ("userId", "jobId", owner, generation, "expiresAt")
      VALUES (${row.order.userId}, ${row.id}, ${owner}, 1, clock_timestamp() + ${leaseMs} * interval '1 millisecond')
      ON CONFLICT ("userId") DO UPDATE SET "jobId" = excluded."jobId", owner = excluded.owner,
        generation = "FulfillmentLease".generation + 1, "expiresAt" = excluded."expiresAt"
      WHERE "FulfillmentLease"."jobId" IS NULL OR ("FulfillmentLease"."jobId" = excluded."jobId"
        AND "FulfillmentLease"."expiresAt" <= clock_timestamp())
      RETURNING generation`;
    if (!lease) return null;
    await markWriter(tx);
    // Repeated process deaths must eventually become visible for operator review.
    if (row.status === "RUNNING" && row.attempts >= MAX_ATTEMPTS) {
      await tx.fulfillmentJob.update({ where: { id: row.id }, data: {
        status: "FAILED", lockedAt: null, lastError: "Lease expired at attempt limit; verify panel before requeue",
      } });
      await tx.fulfillmentLease.update({ where: { userId: row.order.userId },
        data: { owner: null, jobId: null, expiresAt: null } });
      return null;
    }
    await tx.$executeRaw`UPDATE "FulfillmentJob" SET status = 'RUNNING', attempts = attempts + 1,
      "lockedAt" = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = ${row.id}`;
    return { ...row, attempts: row.attempts + 1, generation: lease.generation, owner };
  });
}

function ownership(job: ClaimedJob) {
  return Prisma.sql`"userId" = ${job.order.userId} AND "jobId" = ${job.id} AND owner = ${job.owner}
    AND generation = ${job.generation} AND "expiresAt" > clock_timestamp()`;
}

export async function renewLease(job: ClaimedJob, leaseMs: number): Promise<void> {
  const count = await prisma.$executeRaw`UPDATE "FulfillmentLease"
    SET "expiresAt" = clock_timestamp() + ${leaseMs} * interval '1 millisecond' WHERE ${ownership(job)}`;
  if (count !== 1) throw new LeaseLost();
}

export async function savePlannedExpiry(job: ClaimedJob, target: Date): Promise<Date> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<unknown[]>`SELECT 1 FROM "FulfillmentLease" WHERE ${ownership(job)} FOR UPDATE`;
    if (!rows.length) throw new LeaseLost();
    await markWriter(tx);
    const [saved] = await tx.$queryRaw<{ targetExpireAt: Date }[]>`UPDATE "FulfillmentJob"
      SET "targetExpireAt" = COALESCE("targetExpireAt", ${target}) WHERE id = ${job.id} AND status = 'RUNNING'
      RETURNING "targetExpireAt"`;
    if (!saved) throw new LeaseLost();
    return saved.targetExpireAt;
  });
}

async function finish(job: ClaimedJob, data: Prisma.FulfillmentJobUpdateManyMutationInput,
  onSuccess?: (tx: Db) => Promise<void>): Promise<void> {
  await prisma.$transaction(async tx => {
    const count = await tx.$executeRaw`UPDATE "FulfillmentLease" SET "jobId" = NULL, owner = NULL, "expiresAt" = NULL
      WHERE ${ownership(job)}`;
    if (count !== 1) throw new LeaseLost();
    await markWriter(tx);
    const changed = await tx.fulfillmentJob.updateMany({
      where: { id: job.id, status: "RUNNING" }, data: { ...data, lockedAt: null },
    });
    if (changed.count !== 1) throw new LeaseLost();
    await onSuccess?.(tx);
  });
}

export function completeJob(job: ClaimedJob, result: { remnawaveUserId: number; note?: string }, now: Date) {
  return finish(job, { status: "DONE", completedAt: now, lastError: result.note ?? null }, async tx => {
    await tx.order.updateMany({
      where: { id: job.orderId, status: "PAID" }, data: { status: "FULFILLED", fulfilledAt: now },
    });
    await tx.user.update({ where: { id: job.order.userId }, data: { remnawaveUserId: result.remnawaveUserId } });
  });
}

export function closeJobAsAlreadyDone(job: ClaimedJob, now: Date) {
  return finish(job, { status: "DONE", completedAt: now, lastError: null });
}

export function rescheduleJob(job: ClaimedJob, nextAttemptAt: Date, error: string) {
  return finish(job, { status: "PENDING", nextAttemptAt, lastError: error.slice(0, 500) });
}

export function failJob(job: ClaimedJob, error: string) {
  return finish(job, { status: "FAILED", lastError: error.slice(0, 500) });
}

// Для админки: вернуть упавшую задачу в очередь после того, как проблема устранена
export async function requeueFailedJob(
  jobId: string,
  now: Date = new Date(),
  db: Pick<Db, "fulfillmentJob"> = prisma,
): Promise<boolean> {
  const { count } = await db.fulfillmentJob.updateMany({
    where: { id: jobId, status: "FAILED", assignmentId: null },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lockedAt: null },
  });
  return count === 1;
}
