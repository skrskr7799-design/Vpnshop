import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { LOCK_TIMEOUT_MS } from "./fulfillment.constants";

type Db = Prisma.TransactionClient;

export type ClaimedJob = {
  id: string;
  orderId: string;
  attempts: number;
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

// Брошенные задачи (процесс упал посреди работы) возвращаем в очередь.
// Это безопасно: итоговая дата сохранена в задаче, а применение к панели идемпотентно.
export async function reapStaleJobs(now: Date): Promise<number> {
  const { count } = await prisma.fulfillmentJob.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
    data: { status: "PENDING", lockedAt: null, nextAttemptAt: now, lastError: "recovered after worker interruption" },
  });
  return count;
}

// Сначала исключаем задачи, у которых есть незавершённый предшественник этого
// пользователя. Заблокированная очередь одного клиента не задерживает остальных.
export async function claimNextJob(now: Date): Promise<ClaimedJob | null> {
  const [job] = await prisma.$queryRaw<ClaimedJob[]>`
    WITH candidate AS (
      SELECT j.id, o."userId", o.status, o."durationMonths", o."deviceLimit"
      FROM "FulfillmentJob" j
      JOIN "Order" o ON o.id = j."orderId"
      WHERE j.status = 'PENDING' AND j."nextAttemptAt" <= ${now}
        AND NOT EXISTS (
          SELECT 1
          FROM "Order" earlier_order
          JOIN "FulfillmentJob" earlier ON earlier."orderId" = earlier_order.id
          WHERE earlier_order."userId" = o."userId"
            AND earlier.status <> 'DONE'
            AND (earlier."createdAt", earlier.id) < (j."createdAt", j.id)
        )
      ORDER BY j."createdAt", j.id
      LIMIT 1
      FOR UPDATE OF j SKIP LOCKED
    )
    UPDATE "FulfillmentJob" j
    SET status = 'RUNNING', "lockedAt" = ${now}, attempts = j.attempts + 1
    FROM candidate c
    WHERE j.id = c.id
    RETURNING j.id, j."orderId", j.attempts, j."targetExpireAt",
      json_build_object('id', j."orderId", 'userId', c."userId", 'status', c.status,
                        'durationMonths', c."durationMonths", 'deviceLimit', c."deviceLimit") AS "order"
  `;
  return job ?? null;
}

// Итоговая дата фиксируется один раз и дальше не меняется, даже если задачу придётся повторять.
export async function savePlannedExpiry(jobId: string, targetExpireAt: Date): Promise<void> {
  await prisma.fulfillmentJob.updateMany({ where: { id: jobId, targetExpireAt: null }, data: { targetExpireAt } });
}

// Успех: задача, заказ и привязка пользователя к Remnawave меняются одной транзакцией.
export async function completeJob(
  job: ClaimedJob,
  result: { remnawaveUserId: number; note?: string },
  now: Date,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.fulfillmentJob.update({
      where: { id: job.id },
      data: { status: "DONE", completedAt: now, lockedAt: null, lastError: result.note ?? null },
    });
    await tx.order.updateMany({
      where: { id: job.orderId, status: "PAID" },
      data: { status: "FULFILLED", fulfilledAt: now },
    });
    await tx.user.update({ where: { id: job.order.userId }, data: { remnawaveUserId: result.remnawaveUserId } });
  });
}

// Подписка уже выдана раньше (заказ FULFILLED): просто закрываем задачу
export async function closeJobAsAlreadyDone(jobId: string, now: Date): Promise<void> {
  await prisma.fulfillmentJob.update({
    where: { id: jobId },
    data: { status: "DONE", completedAt: now, lockedAt: null, lastError: null },
  });
}

export async function rescheduleJob(jobId: string, nextAttemptAt: Date, error: string): Promise<void> {
  await prisma.fulfillmentJob.update({
    where: { id: jobId },
    data: { status: "PENDING", lockedAt: null, nextAttemptAt, lastError: error.slice(0, 500) },
  });
}

export async function failJob(jobId: string, error: string): Promise<void> {
  await prisma.fulfillmentJob.update({
    where: { id: jobId },
    data: { status: "FAILED", lockedAt: null, lastError: error.slice(0, 500) },
  });
}

// Для админки: вернуть упавшую задачу в очередь после того, как проблема устранена
export async function requeueFailedJob(
  jobId: string,
  now: Date = new Date(),
  db: Pick<Db, "fulfillmentJob"> = prisma,
): Promise<boolean> {
  const { count } = await db.fulfillmentJob.updateMany({
    where: { id: jobId, status: "FAILED" },
    data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lockedAt: null },
  });
  return count === 1;
}
