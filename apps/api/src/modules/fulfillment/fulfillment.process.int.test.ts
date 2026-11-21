import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createJob, createOrder, createUser } from "../../test/factories";

const loopback = "127.0.0.1";
const cleanup: (() => Promise<void>)[] = [];
beforeEach(async () => { await resetDatabase(); });
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function listen(server: Server) {
  server.listen(0, loopback);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}
async function port() {
  const server = createServer();
  const assigned = await listen(server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return assigned;
}

// Only loopback synthetic HTTP and disposable DB credentials reach child processes.
async function launch(entry: "server" | "worker", panelPort: number, extra: Record<string, string> = {}) {
  const probePort = await port();
  const child = spawn(process.execPath, ["--import", "tsx", `src/${entry}.ts`], {
    stdio: "ignore",
    env: {
      PATH: process.env.PATH, NODE_ENV: "test", DATABASE_URL: process.env.TEST_DATABASE_URL,
      REMNAWAVE_URL: `http://${loopback}:${panelPort}`, REMNAWAVE_TOKEN: "mock",
      REMNAWAVE_INTERNAL_SQUAD_UUIDS: "11111111-1111-4111-8111-111111111111",
      WORKER_HEALTH_PORT: String(probePort), WORKER_LEASE_MS: "15000", WORKER_HTTP_TIMEOUT_MS: "12000",
      WORKER_DRAIN_MS: "8000",
      ...(entry === "server" && { HOST: loopback, PORT: String(probePort), WEB_ORIGIN: "http://localhost",
        COOKIE_SECRET: "c".repeat(40), JWT_SECRET: "j".repeat(40), WORKER_ENABLED: "true" }),
      ...extra,
    },
  });
  const exit = once(child, "exit");
  cleanup.push(async () => { child.kill("SIGKILL"); await exit; });
  const probe = (path: string) => fetch(`http://${loopback}:${probePort}${path}`,
    { signal: AbortSignal.timeout(800) });
  const wait = (path: string, status: number) => vi.waitFor(async () => {
    expect((await probe(path)).status).toBe(status);
  }, { timeout: 12_000, interval: 80 });
  return { child, exit, probe, wait };
}

async function mockPanel() {
  const writes: string[] = [];
  const requests: string[] = [];
  const pending: (() => void)[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.method ?? "");
    if (req.method !== "POST") { res.writeHead(404).end("{}"); return; }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    writes.push(body.expireAt);
    pending.push(() => res.end(JSON.stringify({ response: {
      ...body, id: 123, shortUuid: "mock", subscriptionUrl: "mock", activeInternalSquads: [],
    } })));
  });
  const panelPort = await listen(server);
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { panelPort, writes, pending, requests };
}
async function newJob() { return createJob((await createOrder((await createUser()).id)).id); }
const jobState = (id: string) => prisma.fulfillmentJob.findUniqueOrThrow({ where: { id } });

it("runs API alone, elects one of two worker processes, heartbeats and drains without a second claim", async () => {
  const panel = await mockPanel();
  const job = await newJob();
  const api = await launch("server", panel.panelPort);
  await api.wait("/api/ready", 200);
  // Cross the poll interval of the previous embedded worker.
  await delay(3200);
  expect(await jobState(job.id)).toMatchObject({ status: "PENDING", attempts: 0 });
  expect(panel.writes).toHaveLength(0);
  api.child.kill("SIGTERM");
  expect((await api.exit)[0]).toBe(0);

  const workers = await Promise.all([launch("worker", panel.panelPort), launch("worker", panel.panelPort)]);
  await Promise.all(workers.map(w => w.wait("/ready", 200)));
  await vi.waitFor(() => expect(panel.writes).toHaveLength(1), { timeout: 6000 });
  const lease = () => prisma.fulfillmentLease.findFirstOrThrow({ where: { jobId: job.id } });
  const initial = await lease();
  const identities = await Promise.all(workers.map(async w => ((await (await w.probe("/ready")).json()) as { owner: string }).owner));
  const activeIndex = identities.findIndex(owner => owner === initial.owner);
  expect(activeIndex).toBeGreaterThanOrEqual(0);
  const active = workers[activeIndex]!;
  const idle = workers[1 - activeIndex]!;
  await vi.waitFor(async () => expect((await lease()).expiresAt!.getTime())
    .toBeGreaterThan(initial.expiresAt!.getTime()), { timeout: 7000 });
  expect(await jobState(job.id)).toMatchObject({ status: "RUNNING", attempts: 1 });
  idle.child.kill("SIGINT");
  expect((await idle.exit)[0]).toBe(0);
  active.child.kill("SIGTERM");
  await active.wait("/ready", 503);
  const later = await newJob();
  panel.pending[0]!();
  expect((await active.exit)[0]).toBe(0);
  expect(await jobState(job.id)).toMatchObject({ status: "DONE", attempts: 1 });
  expect(await jobState(later.id)).toMatchObject({ status: "PENDING", attempts: 0 });
  expect(panel.writes).toHaveLength(1);
}, 45_000);

it("recovers after a drain deadline and retries a timed-out write with the stored target", async () => {
  const panel = await mockPanel();
  const job = await newJob();
  const old = await launch("worker", panel.panelPort, {
    WORKER_DRAIN_MS: "250", WORKER_LEASE_MS: "3000", WORKER_HTTP_TIMEOUT_MS: "2500",
  });
  await vi.waitFor(() => expect(panel.writes).toHaveLength(1), { timeout: 8000 });
  old.child.kill("SIGTERM");
  expect((await old.exit)[0]).toBe(1);
  expect(await jobState(job.id)).toMatchObject({ status: "RUNNING", attempts: 1 });
  const recovered = await launch("worker", panel.panelPort, { WORKER_HTTP_TIMEOUT_MS: "400" });
  await vi.waitFor(async () => {
    expect(await jobState(job.id)).toMatchObject({ status: "PENDING", attempts: 2, lastError: expect.stringContaining("Timeout") });
  }, { timeout: 10_000 });
  const retry = await jobState(job.id);
  expect(retry.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  expect(panel.writes).toEqual([retry.targetExpireAt!.toISOString(), retry.targetExpireAt!.toISOString()]);
  recovered.child.kill("SIGTERM");
  expect((await recovered.exit)[0]).toBe(0);
}, 30_000);

it("keeps liveness separate from database readiness on connection failure", async () => {
  const unused = await port();
  const worker = await launch("worker", unused, {
    DATABASE_URL: `postgresql://test:test@${loopback}:${unused}/unreachable?connect_timeout=1`,
  });
  await worker.wait("/health", 200);
  await worker.wait("/ready", 503);
  expect(await (await worker.probe("/ready")).json()).toMatchObject({ ready: false, lastHeartbeat: null });
  worker.child.kill("SIGTERM");
  expect((await worker.exit)[0]).toBe(0);
});

it("runtime worker restores a local boundary and never calls the legacy panel writer", async () => {
  const panel = await mockPanel();
  const user = await createUser();
  const job = await createJob((await createOrder(user.id)).id);
  const subscription = await prisma.subscription.create({
    data: { userId: user.id, nextBoundaryAt: new Date(0) },
  });
  const worker = await launch("worker", panel.panelPort, { NODE_ENV: "production" });
  await worker.wait("/ready", 200);
  const assignment = await prisma.desiredAssignment.findUniqueOrThrow({
    where: { subscriptionId_revision: { subscriptionId: subscription.id, revision: 1 } },
  });
  expect(assignment).toMatchObject({ enabled: false, nextBoundaryAt: null });
  expect(await jobState(job.id)).toMatchObject({ status: "PENDING", attempts: 0 });
  expect(await prisma.fulfillmentJob.findUnique({ where: { assignmentId: assignment.id } }))
    .toMatchObject({ status: "PENDING", orderId: null });
  expect(panel.requests).toEqual([]);
  worker.child.kill("SIGTERM");
  expect((await worker.exit)[0]).toBe(0);
});
