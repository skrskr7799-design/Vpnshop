import type { Logger } from "../../lib/log";
import { RemnawaveError } from "../remnawave/remnawave.errors";
import { applySubscription, planExpiry, type RemnawaveApi } from "../remnawave/remnawave.provisioning";
import { remnawaveUsernameFor } from "../remnawave/remnawave.username";
import { backoffMs } from "./fulfillment.backoff";
import { MAX_ATTEMPTS, OPERATOR_RETRY_MS } from "./fulfillment.constants";
import {
  LeaseLost,
  closeJobAsAlreadyDone,
  completeJob,
  failJob,
  rescheduleJob,
  savePlannedExpiry,
  type ClaimedJob,
} from "./fulfillment.queue";

export type ProcessorDeps = {
  api: RemnawaveApi;
  internalSquadUuids: string[];
  log: Logger;
  now?: () => Date;
  random?: () => number;
  beforePanelCall?: () => Promise<void>;
};

export type JobOutcome = "done" | "retry" | "failed";

// Выдача подписки по одной задаче.
// Порядок важен: 1) один раз вычисляем итоговую дату и сохраняем её в задаче,
// 2) применяем к панели абсолютными значениями, 3) фиксируем результат в БД.
// Если процесс упадёт между 2 и 3, повторный запуск применит те же значения и ничего не удвоит.
export async function processJob(job: ClaimedJob, deps: ProcessorDeps): Promise<JobOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log;
  const ctx = { jobId: job.id, orderId: job.orderId, attempt: job.attempts };

  try {
    if (job.order.status === "FULFILLED") {
      await closeJobAsAlreadyDone(job, now());
      return "done";
    }
    if (job.order.status !== "PAID") {
      await failJob(job, `order status is ${job.order.status}, expected PAID`);
      log.error(ctx, "fulfillment: заказ не в статусе PAID, задача остановлена");
      return "failed";
    }

    const username = remnawaveUsernameFor(job.order.userId);

    const api: RemnawaveApi = {
      async getUserByUsername(name) { await deps.beforePanelCall?.(); return deps.api.getUserByUsername(name); },
      async createUser(input) { await deps.beforePanelCall?.(); return deps.api.createUser(input); },
      async updateUser(input) { await deps.beforePanelCall?.(); return deps.api.updateUser(input); },
    };
    let targetExpireAt = job.targetExpireAt;
    if (!targetExpireAt) {
      targetExpireAt = await planExpiry(api, username, job.order.durationMonths, now());
      targetExpireAt = await savePlannedExpiry(job, targetExpireAt);
    }

    const result = await applySubscription(api, {
      username,
      targetExpireAt,
      deviceLimit: job.order.deviceLimit,
      internalSquadUuids: deps.internalSquadUuids,
    });

    const note = result.stillDisabled
      ? "user is DISABLED in panel: subscription extended but user was not re-enabled"
      : undefined;
    await completeJob(job, { remnawaveUserId: result.user.id, note }, now());
    if (note) log.warn(ctx, `fulfillment: ${note}`);
    else log.info({ ...ctx, created: result.created }, "fulfillment: подписка выдана");
    return "done";
  } catch (err) {
    if (err instanceof LeaseLost) throw err;
    return handleFailure(job, err, deps, ctx);
  }
}

async function handleFailure(
  job: ClaimedJob,
  err: unknown,
  deps: ProcessorDeps,
  ctx: object,
): Promise<JobOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const message = err instanceof Error ? err.message : String(err);

  // Токен/версия панели неверны: нужен человек. Задачу не бросаем, а держим в очереди,
  // чтобы после исправления настройки она выполнилась сама.
  if (err instanceof RemnawaveError && err.needsOperator) {
    await rescheduleJob(job, new Date(now.getTime() + OPERATOR_RETRY_MS), message);
    deps.log.error({ ...ctx, kind: err.kind }, `fulfillment: нужно вмешательство оператора: ${message}`);
    return "retry";
  }

  // Панель отклонила запрос по существу (например, неверные данные): повтор бессмыслен
  if (err instanceof RemnawaveError && !err.retryable) {
    await failJob(job, message);
    deps.log.error({ ...ctx, kind: err.kind }, `fulfillment: панель отклонила запрос: ${message}`);
    return "failed";
  }

  // Временная недоступность панели или неожиданная ошибка: повторяем с нарастающей паузой
  if (job.attempts >= MAX_ATTEMPTS) {
    await failJob(job, `gave up after ${job.attempts} attempts: ${message}`);
    deps.log.error(ctx, `fulfillment: попытки исчерпаны: ${message}`);
    return "failed";
  }
  await rescheduleJob(job, new Date(now.getTime() + backoffMs(job.attempts, deps.random)), message);
  deps.log.warn(ctx, `fulfillment: временный сбой, повторим позже: ${message}`);
  return "retry";
}
