import { randomUUID } from "node:crypto";
import { DEFAULT_LEASE_MS, MAX_HEARTBEAT_INTERVAL_MS, MAX_JOBS_PER_TICK, POLL_INTERVAL_MS } from "./fulfillment.constants";
import { processJob, type ProcessorDeps } from "./fulfillment.processor";
import { claimNextJob, LeaseLost, renewLease, renewOwnedLease, rescheduleJob } from "./fulfillment.queue";

import type { AssignmentPanel } from "../remnawave/remnawave.assignment";
import { processRevision } from "./revision.processor";
import { claimRevision } from "./revision.queue";

export type WorkerOptions = Omit<ProcessorDeps, "api"> & { api?: ProcessorDeps["api"] } & { pollIntervalMs?: number; leaseMs?: number; maintenance?: () => Promise<number>; panel?: AssignmentPanel };
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

  async function execute(heartbeat: () => Promise<void>, process: (renew: () => Promise<void>) => Promise<void>) {
    let lost = false;
    async function renew() {
      if (lost) throw new LeaseLost();
      await heartbeat();
      alive();
    }
    let inFlight: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = renew().catch(() => {
        lost = true;
        healthy = false;
        options.log.warn({ reasonCode: "LEASE_RENEWAL_FAILED" }, "fulfillment heartbeat failed");
      }).finally(() => { inFlight = undefined; });
    }, heartbeatMs);
    try {
      await process(renew);
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
      if (!options.panel) return processed;
    }
    const panel = options.panel;
    if (panel) {
      let processed = 0;
      while (!stopping && processed < MAX_JOBS_PER_TICK) {
        const job = await claimRevision(owner, leaseMs);
        alive();
        if (!job) break;
        if (stopping) break; // Lease expires and verify-first resumes in the next process.
        await execute(() => renewOwnedLease(job, leaseMs), () => processRevision(job, panel));
        processed++;
      }
      return processed;
    }
    const api = options.api;
    if (!api) throw new Error("No legacy processor configured");
    let processed = 0;
    while (!stopping && processed < MAX_JOBS_PER_TICK) {
      const job = await claimNextJob(owner, leaseMs, options.now?.());
      alive();
      if (!job) break;
      if (stopping) {
        await rescheduleJob(job, new Date(), "worker draining before dispatch");
        break;
      }
      await execute(() => renewLease(job, leaseMs), async renew => {
        await processJob(job, { ...options, api, beforePanelCall: renew });
      });
      processed++;
    }
    return processed;
  }

  async function run() {
    while (!stopping) {
      try {
        await tick();
      } catch {
        healthy = false;
        options.log.error({ reasonCode: "FULFILLMENT_POLL_FAILED" }, "fulfillment polling failed");
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
