import { randomUUID } from "node:crypto";
import { DEFAULT_LEASE_MS, MAX_HEARTBEAT_INTERVAL_MS, MAX_JOBS_PER_TICK, POLL_INTERVAL_MS } from "./fulfillment.constants";
import { processJob, type ProcessorDeps } from "./fulfillment.processor";
import { claimNextJob, LeaseLost, renewLease, rescheduleJob, type ClaimedJob } from "./fulfillment.queue";

export type WorkerOptions = ProcessorDeps & { pollIntervalMs?: number; leaseMs?: number; maintenance?: () => Promise<number> };
export type FulfillmentWorker = ReturnType<typeof createFulfillmentWorker>;

export function createFulfillmentWorker(options: WorkerOptions) {
  const owner = randomUUID();
  const pollMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatMs = Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.floor(leaseMs / 3));
  let stopping = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let lastHeartbeat = 0;
  let healthy = false;

  function alive() {
    lastHeartbeat = Date.now();
    healthy = true;
  }

  async function execute(job: ClaimedJob) {
    let lost = false;
    async function renew() {
      if (lost) throw new LeaseLost();
      await renewLease(job, leaseMs);
      alive();
    }
    let inFlight: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = renew().catch(err => {
        lost = true;
        healthy = false;
        options.log.warn({ err, jobId: job.id }, "fulfillment heartbeat failed");
      }).finally(() => { inFlight = undefined; });
    }, heartbeatMs);
    try {
      await processJob(job, { ...options, beforePanelCall: renew });
    } finally {
      clearInterval(timer);
      await inFlight;
    }
  }

  async function tick(): Promise<number> {
    if (stopping) return 0;
    if (options.maintenance) {
      const processed = await options.maintenance();
      alive();
      return processed;
    }
    let processed = 0;
    while (!stopping && processed < MAX_JOBS_PER_TICK) {
      const job = await claimNextJob(owner, leaseMs, options.now?.());
      alive();
      if (!job) break;
      if (stopping) {
        await rescheduleJob(job, new Date(), "worker draining before dispatch");
        break;
      }
      await execute(job);
      processed++;
    }
    return processed;
  }

  async function run() {
    while (!stopping) {
      try {
        await tick();
      } catch (err) {
        healthy = false;
        options.log.error({ err }, "fulfillment polling failed");
      }
      if (!stopping) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  }

  return {
    tick,
    start() { loop ??= run(); },
    async stop() {
      stopping = true;
      wake?.();
      await loop;
    },
    status() {
      return { owner, draining: stopping, lastHeartbeat: lastHeartbeat || null,
        ready: !stopping && healthy && Date.now() - lastHeartbeat <= 2 * Math.max(heartbeatMs, pollMs) };
    },
  };
}
