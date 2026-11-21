import type { Logger } from "../../lib/log";
import { MAX_JOBS_PER_TICK, POLL_INTERVAL_MS } from "./fulfillment.constants";
import { processJob, type ProcessorDeps } from "./fulfillment.processor";
import { claimNextJob, reapStaleJobs } from "./fulfillment.queue";

export type WorkerOptions = ProcessorDeps & { log: Logger; pollIntervalMs?: number };

export type FulfillmentWorker = {
  /** Один проход: вернуть брошенные задачи и обработать всё, что готово. Возвращает число задач. */
  tick(): Promise<number>;
  /** Запустить фоновый цикл опроса (повторный вызов ничего не делает) */
  start(): void;
  /** Остановить цикл, дождавшись текущей задачи */
  stop(): Promise<void>;
};

// Создание воркера ничего не запускает: цикл стартует только по start().
export function createFulfillmentWorker(options: WorkerOptions): FulfillmentWorker {
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  async function tick(): Promise<number> {
    const recovered = await reapStaleJobs(now());
    if (recovered > 0) options.log.warn({ recovered }, "fulfillment: возвращены брошенные задачи");

    let processed = 0;
    while (!stopped && processed < MAX_JOBS_PER_TICK) {
      const job = await claimNextJob(now());
      if (!job) break;
      await processJob(job, options);
      processed++;
    }
    return processed;
  }

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        // Сбой БД не должен убивать воркер: логируем и пробуем на следующем проходе
        options.log.error({ err }, "fulfillment: сбой прохода воркера");
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pollIntervalMs ?? POLL_INTERVAL_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  return {
    tick,
    start() {
      loop ??= run();
    },
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
