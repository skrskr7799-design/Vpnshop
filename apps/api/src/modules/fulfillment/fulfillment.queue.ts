import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { CLAIM_CANDIDATES, LOCK_TIMEOUT_MS } from "./fulfillment.constants";

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

// Берёт следующую готовую задачу.
// Порядок строгий в пределах одного пользователя: пока не завершена более ранняя задача этого же
// пользователя, следующую не трогаем. Иначе две задачи посчитали бы дату от одного и того же
// состояния панели, и одна перезаписала бы другую (потерянное продление).
// Захват атомарный (compare-and-set): два воркера не возьмут одну задачу.
export async function claimNextJob(now: Date): Promise<ClaimedJob | null> {
  const candidates = await prisma.fulfillmentJob.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: CLAIM_CANDIDATES,
    select: { id: true, createdAt: true, order: { select: { userId: true } } },
  });

  for (const candidate of candidates) {
    const blocker = await prisma.fulfillmentJob.findFirst({
      where: {
        id: { not: candidate.id },
        status: { not: "DONE" },
        order: { userId: candidate.order.userId },
        OR: [
          { createdAt: { lt: candidate.createdAt } },
          { createdAt: candidate.createdAt, id: { lt: candidate.id } },
        ],
      },
      select: { id: true },
    });
    if (blocker) continue;

    const claimed = await prisma.fulfillmentJob.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "RUNNING", lockedAt: now, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue; // успел другой воркер

    return prisma.fulfillmentJob.findUniqueOrThrow({
      where: { id: candidate.id },
      select: {
        id: true,
        orderId: true,
        attempts: true,
        targetExpireAt: true,
        order: { select: { id: true, userId: true, status: true, durationMonths: true, deviceLimit: true } },
      },
    });
  }
  return null;
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
