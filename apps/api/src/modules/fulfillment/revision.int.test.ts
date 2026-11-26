import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { mockPanel, secret } from "../../test/revision-panel";
import { createSession, revokeSessionFamily } from "../auth/session.service";
import { dbNow } from "../commerce/offers";
import { recordLookup } from "../payments/ledger";
import { createFakePanel } from "../remnawave/remnawave.testing";
import { RemnawaveError } from "../remnawave/remnawave.errors";
import { allocateCapture } from "../subscriptions/allocation";
import { placeStaffHold, releaseStaffHold } from "../subscriptions/holds";
import { lockSubscription, projectAssignment, refreshDueAssignments, subscriptionTransaction } from "../subscriptions/store";
import { createFulfillmentWorker } from "./fulfillment.worker";
import { processRevision } from "./revision.processor";
import { claimRevision, requestRevisionCheck } from "./revision.queue";

const squad = "11111111-1111-4111-8111-111111111111";
const secondSquad = "22222222-2222-4222-8222-222222222222";


let fixture: ReturnType<typeof mockPanel>;
let user: Awaited<ReturnType<typeof createUser>>;
let admin: Awaited<ReturnType<typeof createUser>>;
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("REMNAWAVE_REVISION_MODE", "staging");
  vi.stubEnv("REMNAWAVE_STAGING_ORIGIN", "https://panel.example.invalid");
  vi.stubEnv("REMNAWAVE_STAGING_LINK_ORIGIN", "https://links.example.invalid");
  vi.stubEnv("REMNAWAVE_STAGING_TOKEN", "synthetic-only");
  vi.stubEnv("REMNAWAVE_STAGING_INSTANCE", "staging-test");
  vi.stubEnv("REMNAWAVE_STAGING_SQUADS", squad);
  fixture = mockPanel();
  user = await createUser();
  admin = await prisma.user.create({ data: { role: "ADMIN" } });
});
afterEach(() => { vi.unstubAllEnvs(); });

async function booking(deviceLimit = 5) {
  const merchant = await prisma.merchantAccount.create({ data: { provider: "PLATEGA", environment: "MOCK", merchant: randomUUID() } });
  const plan = await prisma.plan.create({ data: { code: randomUUID(), name: "Fixture", deviceLimit } });
  const price = await prisma.planPrice.create({ data: { planId: plan.id, durationMonths: 1, currency: "RUB", amount: 100 } });
  const createdAt = await dbNow(prisma);
  const version = await prisma.offerVersion.create({ data: {
    planPriceId: price.id, name: plan.name, amount: price.amount, currency: price.currency, durationMonths: 1,
    version: 1, deviceLimit, publishedAt: createdAt,
  } });
  const order = await prisma.order.create({ data: {
    userId: user.id, planId: plan.id, offerVersionId: version.id, checkoutKeyHash: randomUUID(), checkoutPolicyVersion: 1,
    currency: price.currency, amount: price.amount, deviceLimit, durationMonths: 1, createdAt, expiresAt: new Date(+createdAt + 1_800_000),
  } });
  const payment = await prisma.payment.create({ data: {
    orderId: order.id, provider: merchant.provider, accountId: merchant.id, merchantReference: randomUUID(),
    requestKeyHash: randomUUID(), externalId: randomUUID(), expiresAt: order.expiresAt, channel: "SBP",
    currency: order.currency, amount: order.amount, status: "PROCESSING",
  } });
  const capture = async (fixtureWindow?: { startAt: Date; endAt: Date; serial: number }) => {
    const key = randomUUID();
    await recordLookup(merchant, {
      externalPaymentId: payment.externalId!, merchantReference: payment.merchantReference, status: "CONFIRMED",
      movement: { key, kind: "CAPTURE", amountMinor: "100", currency: "RUB", providerTime: (await dbNow(prisma)).toISOString(),
        originalMovementKey: null },
    });
    const fact = await prisma.paymentTransaction.findUniqueOrThrow({ where: { accountId_movementKey: { accountId: merchant.id, movementKey: key } } });
    if (fixtureWindow) return subscriptionTransaction(async db => {
      const subscription = await lockSubscription(db, user.id);
      if (!subscription) throw new Error("Missing boundary fixture subscription");
      const time = await dbNow(db);
      const allocation = await db.orderAllocation.create({ data: { orderId: order.id, captureId: fact.id, createdAt: time } });
      const grant = await db.periodGrant.create({ data: {
        subscriptionId: subscription.id, orderId: order.id, allocationId: allocation.id,
        ...fixtureWindow, createdAt: time, calendarVersion: 1, deviceLimit,
      } });
      await projectAssignment(db, subscription, time, "BOUNDARY_FIXTURE", true);
      return grant;
    });
    const result = await allocateCapture(fact.id);
    if (result.status !== "ALLOCATED") throw new Error(result.reason);
    return result.grant;
  };
  return { capture };
}

const jobFor = async () => prisma.fulfillmentJob.findFirstOrThrow({
  where: { assignment: { subscription: { userId: user.id } } }, orderBy: { assignment: { revision: "desc" } },
});
const binding = () => prisma.panelBinding.findFirstOrThrow({ where: { subscription: { userId: user.id } } });
const due = async () => prisma.fulfillmentJob.update({ where: { id: (await jobFor()).id }, data: { nextAttemptAt: new Date(0) } });
async function tick(owner = "worker") {
  const job = await claimRevision(owner, 5000);
  expect(job).not.toBeNull();
  await processRevision(job!, fixture.panel);
  return job!;
}
async function republishSquads(id: string) {
  vi.stubEnv("REMNAWAVE_STAGING_SQUADS", id);
  return subscriptionTransaction(async db =>
    projectAssignment(db, (await lockSubscription(db, user.id))!, await dbNow(db), "STAGING_POLICY"));
}

it("creates only for proven rights, verifies identity and shares one lease across concurrent consumers", async () => {
  const purchase = await booking();
  expect(await claimRevision("without-capture", 5000)).toBeNull();
  expect(fixture.panel.createUser).not.toHaveBeenCalled();
  const grant = await purchase.capture();
  const backends = await Promise.all([0, 1].map(() => prisma.$transaction(async db => {
    const [backend] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM pg_sleep(0.1)`;
    return backend!.pid;
  })));
  expect(new Set(backends).size).toBe(2);
  const leases = await Promise.all([claimRevision("first", 5000), claimRevision("second", 5000)]);
  const job = leases.find(lease => lease !== null)!;
  expect(leases.filter(Boolean)).toHaveLength(1);
  await processRevision(job, fixture.panel);
  expect(await binding()).toMatchObject({ remoteUserId: 922n, confirmedRevision: 1, panelInstance: "staging-test" });
  expect(fixture.current).toMatchObject({ expiresAt: grant.endAt, deviceLimit: 5, squads: [squad] });
  expect((await jobFor()).status).toBe("CONFIRMED");
  expect(fixture.panel.createUser).toHaveBeenCalledTimes(1);
  const renewed = await booking(8);
  const next = await renewed.capture();
  expect(next.startAt).toEqual(grant.endAt);
  await tick();
  expect(fixture.current?.expiresAt).toEqual(grant.endAt);
  expect(fixture.panel.createUser).toHaveBeenCalledTimes(1);
});

it("reads before retrying an unknown create and survives a crash after an external write", async () => {
  await (await booking()).capture();
  const create = fixture.panel.createUser.getMockImplementation()!;
  fixture.panel.createUser.mockImplementationOnce(async (...args) => {
    await create(...args);
    throw new RemnawaveError("unavailable", null, "Synthetic timeout");
  });
  await tick();
  expect((await jobFor()).status).toBe("VERIFY_PENDING");
  await due();
  // Simulate a new consumer dying after issuing an absolute PATCH and before settling.
  const job = await claimRevision("crash", 5000);
  const user = fixture.current!;
  await fixture.panel.updateAbsoluteProfile(user.id, { ...user, deviceLimit: 2 });
  await prisma.fulfillmentLease.update({ where: { userId: job!.userId }, data: { expiresAt: new Date(0) } });
  const recovered = await tick("restart");
  expect(recovered.generation).toBeGreaterThan(job!.generation);
  expect((await jobFor()).status).toBe("CONFIRMED");
  expect(fixture.panel.createUser).toHaveBeenCalledTimes(1);
  expect(fixture.current?.deviceLimit).toBe(5);
});

it("rejects a stale late writer and rechecks the latest confirmed disable", async () => {
  await (await booking()).capture();
  await tick();
  await republishSquads(secondSquad);
  const old = (await claimRevision("A", 5000))!;
  let resume!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const release = new Promise<void>(resolve => { resume = resolve; });
  fixture.panel.updateAbsoluteProfile.mockImplementationOnce(async (_id, profile) => {
    started();
    await release;
    fixture.setProfile(profile);
    // Simulate a remote server that committed the older enable after B's disable.
    fixture.current!.status = "ACTIVE";
  });
  const runOld = processRevision(old, fixture.panel);
  try {
    await waiting;
    await placeStaffHold(user.id, admin.id, "dispute", "FRAUD", "test");
    await prisma.fulfillmentLease.update({ where: { userId: user.id }, data: { expiresAt: new Date(0) } });
    const latest = await tick("B");
    expect(latest.revision).toBeGreaterThan(old.revision);
    expect(fixture.current?.status).toBe("DISABLED");
    expect((await jobFor()).status).toBe("CONFIRMED");
  } finally {
    resume();
    await runOld;
  }
  expect((await jobFor()).status).toBe("VERIFY_PENDING");
  expect((await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("SUPERSEDED");
  expect(await prisma.panelObservation.count({ where: { revision: old.revision, generation: old.generation } })).toBe(0);
  await tick("C");
  expect(fixture.current?.status).toBe("DISABLED");
  expect((await jobFor()).status).toBe("CONFIRMED");
  // Crash after dispatch would drop the immediate signal. Even CONFIRMED stays in the drift scanner.
  fixture.current!.status = "ACTIVE";
  await due();
  await tick("periodic");
  expect(fixture.current?.status).toBe("DISABLED");
});

it("repairs drift of expiry, limit and squads after CONFIRMED and keeps a manual disable", async () => {
  const grant = await (await booking()).capture();
  await tick();
  fixture.change({ ...fixture.current!, deviceLimit: 11, expiresAt: new Date(0), squads: [secondSquad] });
  await due();
  await tick();
  expect(fixture.current).toMatchObject({ expiresAt: grant.endAt, deviceLimit: 5, squads: [squad] });
  fixture.current!.status = "DISABLED";
  await due();
  await tick();
  expect((await jobFor()).lastError).toBe("MANUAL_DISABLE_REVIEW");
  expect((await binding()).blockedReason).toBe("MANUAL_DISABLE_REVIEW");
  expect(fixture.panel.enableUser).not.toHaveBeenCalled();
});

it.each(["username", "remote-id", "missing"] as const)("isolates %s conflicts and keeps operator evidence", async scenario => {
  await (await booking()).capture();
  const base = { id: 45, username: "unknown", marker: "foreign", status: "ACTIVE" as const,
    expiresAt: new Date(), deviceLimit: 8, squads: [] };
  if (scenario === "username") fixture.change(base);
  else {
    await tick();
    fixture.change(scenario === "missing" ? null : { ...fixture.current!, id: 16 });
    await due();
  }
  await tick();
  expect((await jobFor()).status).toBe("NEEDS_REVIEW");
  expect((await binding()).blockedReason).toBe(scenario === "missing" ? "BOUND_USER_MISSING" : "PANEL_IDENTITY_CONFLICT");
  expect(fixture.panel.updateAbsoluteProfile).not.toHaveBeenCalled();
});

it("checks ownership and revokes local links across multiple holds, enabling only after all are released", async () => {
  await (await booking()).capture();
  await tick();
  const app = await buildApp({ panel: fixture.panel });
  const token = (await createSession(user, {})).accessToken;
  const other = (await createSession(await createUser(), {})).accessToken;
  const link = (session: string) => app.inject({ method: "POST", url: "/api/me/subscription/access",
    headers: { origin: env.WEB_ORIGIN }, cookies: { vpn_at: session }, payload: {},
  });
  try {
    expect((await link(other)).statusCode).toBe(409);
    const reply = await link(token);
    expect(reply.json()).toEqual({ subscriptionUrl: secret });
    expect(reply.headers["cache-control"]).toBe("private, no-store");

    fixture.panel.getSubscriptionLink.mockImplementationOnce(async () => {
      await placeStaffHold(user.id, admin.id, "A", "ADMIN", "test");
      return { user: fixture.current!, url: secret };
    });
    expect((await link(token)).statusCode).toBe(409); // Hold committed during the read.
    await tick();
    await placeStaffHold(user.id, admin.id, "B", "FRAUD", "test");
    await releaseStaffHold(user.id, admin.id, "A", "test");
    expect((await link(token)).statusCode).toBe(409);
    expect(fixture.current?.status).toBe("DISABLED");
    await releaseStaffHold(user.id, admin.id, "B", "test");
    await tick();
    expect(fixture.panel.enableUser).toHaveBeenCalledTimes(1);
    expect((await link(token)).statusCode).toBe(200);
    const next = await createSession(user, {});
    fixture.panel.getSubscriptionLink.mockImplementationOnce(async () => {
      await revokeSessionFamily(next.refreshToken);
      return { user: fixture.current!, url: secret };
    });
    const revoked = await link(next.accessToken);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.body).not.toContain(secret);
    const history = await prisma.panelObservation.findMany({ select: { comparison: true, status: true, squads: true } });
    expect(JSON.stringify(history)).not.toContain(secret);
  } finally { await app.close(); }
});

it("projects the boundary and ignores an expired lease before issuing any HTTP", async () => {
  await (await booking()).capture();
  const job = (await claimRevision("old", 5000))!;
  await prisma.fulfillmentLease.update({ where: { userId: job.userId }, data: { expiresAt: new Date(0) } });
  await processRevision(job, fixture.panel);
  expect(fixture.panel.findUser).not.toHaveBeenCalled();
  await tick("new");
  expect(await refreshDueAssignments()).toBe(0);
  expect((await jobFor()).status).toBe("CONFIRMED");
});

it("disables across a real period boundary and applies the new profile only at the future start", async () => {
  await prisma.subscription.create({ data: { userId: user.id } });
  const first = await booking();
  const second = await booking(9);
  const now = await dbNow(prisma);
  const firstEnd = new Date(+now + 2000);
  const secondStart = new Date(+now + 3800);
  await first.capture({ startAt: new Date(+now - 1000), endAt: firstEnd, serial: 1 });
  const future = await second.capture({ startAt: secondStart, endAt: new Date(+secondStart + 86_400_000), serial: 2 });
  await tick();
  expect(fixture.current).toMatchObject({ status: "ACTIVE", deviceLimit: 5, expiresAt: firstEnd });
  await vi.waitFor(async () => { expect(+await dbNow(prisma)).toBeGreaterThanOrEqual(+firstEnd); }, { timeout: 4000 });
  expect(await refreshDueAssignments()).toBe(1);
  await tick();
  expect(fixture.current?.status).toBe("DISABLED");
  await vi.waitFor(async () => { expect(+await dbNow(prisma)).toBeGreaterThanOrEqual(+secondStart); }, { timeout: 4000 });
  expect(await refreshDueAssignments()).toBe(1);
  await tick();
  expect(fixture.current).toMatchObject({ status: "ACTIVE", deviceLimit: 9, expiresAt: future.endAt });
});

it("keeps a verification request delivered during a newer worker's lease and drains safely", async () => {
  await (await booking()).capture();
  await tick();
  await republishSquads(secondSquad);
  const newer = (await claimRevision("active", 5000))!;
  await requestRevisionCheck(newer);
  await processRevision(newer, fixture.panel);
  expect((await jobFor()).status).toBe("VERIFY_PENDING");

  let entered!: () => void;
  let allow!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { allow = resolve; });
  fixture.panel.readBack.mockImplementationOnce(async () => {
    entered();
    await release;
    return fixture.current;
  });
  const worker = createFulfillmentWorker({
    panel: fixture.panel, api: createFakePanel().api, internalSquadUuids: [squad],
    leaseMs: 5000, log: { info() {}, warn() {}, error() {} },
  });
  worker.start();
  try {
    await pending;
    const stopping = worker.stop();
    expect(worker.status().draining).toBe(true);
    allow();
    await stopping;
    expect(worker.status().ready).toBe(false);
    expect((await jobFor()).status).toBe("CONFIRMED");
    expect(await prisma.fulfillmentLease.count({ where: { jobId: { not: null } } })).toBe(0);
  } finally {
    allow();
    await worker.stop();
  }
});

it("retains a paid obligation while the panel is paused and recovers its squad profile on resume", async () => {
  vi.stubEnv("REMNAWAVE_ENABLED", "false");
  vi.stubEnv("REMNAWAVE_STAGING_TOKEN", "");
  const grant = await (await booking()).capture();
  const before = await jobFor();
  const assignment = await prisma.desiredAssignment.findUniqueOrThrow({ where: { id: before.assignmentId! } });
  expect(assignment).toMatchObject({ enabled: true, internalSquads: [] });
  expect(await refreshDueAssignments()).toBe(0);
  expect(await claimRevision("resume", 5000, true)).toBeNull();
  expect(before.attempts).toBe(0);
  expect(fixture.panel.createUser).not.toHaveBeenCalled();

  vi.stubEnv("REMNAWAVE_ENABLED", "true");
  vi.stubEnv("REMNAWAVE_STAGING_TOKEN", "synthetic-only");
  expect(await refreshDueAssignments(20, true)).toBe(1);
  await tick();
  expect(await jobFor()).toMatchObject({ status: "CONFIRMED" });
  expect(fixture.current).toMatchObject({ expiresAt: grant.endAt, squads: [squad] });
  expect(await prisma.paymentTransaction.count()).toBe(1);
  expect(await prisma.periodGrant.count()).toBe(1);
});
