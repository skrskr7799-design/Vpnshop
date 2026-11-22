import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { createSession } from "../auth/session.service";
import { buildApp } from "../../app";
import { currentCode } from "./auth/totp";
import { as, buildTestAdminApp, createEnrolledAdmin, PASSWORD, prepareCommand, type EnrolledAdmin } from "./admin.test-helpers";
import { financeFact, paidOrder } from "./admin.fixtures";

let app: FastifyInstance;
let alice: EnrolledAdmin;
let bob: EnrolledAdmin;
let first: ReturnType<typeof as>;
let second: ReturnType<typeof as>;
beforeEach(async () => {
  await resetDatabase();
  app = await buildTestAdminApp();
  alice = await createEnrolledAdmin("alice@example.invalid");
  bob = await createEnrolledAdmin("bob@example.invalid");
  first = as(app, alice.sessionToken);
  second = as(app, bob.sessionToken);
});
afterEach(async () => { await app.close(); });

const bodyOf = { code: "fixture", name: "Fixture", deviceLimit: 4 };
const offer = { name: "Test", amountMinor: 19000, durationMonths: 1, deviceLimit: 4, currency: "RUB" };
const reason = "Validate staff mutation";
const send = (staff: EnrolledAdmin, operation: string, target: string, payload: object, key = randomUUID()) =>
  app.inject({ method: "POST", url: `/api/commands/${operation}/${encodeURIComponent(target)}`,
    headers: { origin: env.ADMIN_ORIGIN, "idempotency-key": key }, cookies: { vpn_admin: staff.sessionToken }, payload });

it("issues a fresh TOTP proof, rejects cross-session use and returns one command after lost response", async () => {
  await prisma.adminTotp.update({ where: { userId: alice.userId }, data: { lastUsedStep: null } });
  const input = { operation: "plan.create", targetId: "fixture", permission: "plans:write", expectedVersion: "0", reason, command: bodyOf };
  const proof = await first.post("/api/auth/step-up", { ...input, password: PASSWORD, code: currentCode(alice.secret) });
  expect(proof.statusCode).toBe(200);
  const body = { command: bodyOf, confirmationId: proof.json().confirmationId, expectedVersion: "0", reason };
  expect((await send(bob, "plan.create", "fixture", body)).json().error.code).toBe("STEP_UP_REQUIRED");

  const key = randomUUID();
  const requests = await Promise.all([send(alice, "plan.create", "fixture", body, key), send(alice, "plan.create", "fixture", body, key)]);
  expect(requests.map(reply => reply.statusCode)).toEqual([200, 200]);
  expect(requests[0]!.json()).toEqual(requests[1]!.json());
  expect((await send(alice, "plan.create", "fixture", body)).json().error.code).toBe("STEP_UP_REQUIRED");
  expect((await send(alice, "plan.create", "fixture", { ...body, command: { ...bodyOf, name: "Unexpected" } }, key)).json().error.code)
    .toBe("IDEMPOTENCY_CONFLICT");
  expect(await prisma.plan.count()).toBe(1);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "plan.create" } });
  expect(audit).toMatchObject({ role: "ADMIN", permission: "plans:write", reason, commandId: requests[0]!.json().commandId });
  expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  await expect(prisma.auditLog.update({ where: { id: audit.id }, data: { action: "rewrite" } })).rejects.toBeTruthy();
});

it("rejects stale/expired proofs and rolls back the local effect on failed audit", async () => {
  expect((await first.command("plan.create", "fixture", 0, bodyOf, { expired: true })).json().error.code).toBe("STEP_UP_REQUIRED");
  const broken = await prepareCommand(alice.sessionToken, "plan.create", "fixture", 0, bodyOf, { reason: "fixture audit insert failure" });
  expect((await send(alice, "plan.create", "fixture", broken)).statusCode).toBe(500);
  expect(await prisma.plan.count()).toBe(0);
  expect(await prisma.adminCommand.count()).toBe(0);
  expect((await prisma.adminConfirmation.findUniqueOrThrow({ where: { id: broken.confirmationId } })).consumedAt).toBeNull();

  const plan = await prisma.plan.create({ data: bodyOf });
  const proof = await prepareCommand(alice.sessionToken, "plan.publish", plan.id, 0, offer);
  let unblock!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const contention = prisma.$transaction(async db => {
    await db.$queryRaw`SELECT id FROM "Plan" WHERE id = ${plan.id} FOR UPDATE`;
    locked();
    await gate;
  });
  try {
    await acquired;
    await prisma.adminConfirmation.update({ where: { id: proof.confirmationId }, data: { expiresAt: new Date(Date.now() + 400) } });
    const pending = send(alice, "plan.publish", plan.id, proof);
    await new Promise(resolve => setTimeout(resolve, 550));
    unblock();
    expect((await pending).json().error.code).toBe("STEP_UP_REQUIRED");
  } finally { unblock(); await contention; }
  expect(await prisma.offerVersion.count()).toBe(0);
  expect((await second.command("plan.publish", plan.id, 0, offer)).statusCode).toBe(200);
  expect((await first.command("plan.publish", plan.id, 0, offer)).json().error.code).toBe("VERSION_CONFLICT");
});

it("prevents two concurrent mutual demotions and invalidates a revoked actor's pre-issued proof", async () => {
  const pending = await prepareCommand(bob.sessionToken, "plan.create", "fixture", 0, bodyOf);
  const requests = await Promise.all([
    first.command("staff.role", bob.userId, 1, { role: "SUPPORT" }),
    second.command("staff.role", alice.userId, 1, { role: "SUPPORT" }),
  ]);
  expect(requests.filter(response => response.statusCode === 200)).toHaveLength(1);
  expect(await prisma.user.count({ where: { role: "ADMIN", status: "ACTIVE" } })).toBe(1);
  if (requests[0]!.statusCode === 200) expect((await send(bob, "plan.create", "fixture", pending)).statusCode).toBe(401);
  const winner = requests[0]!.statusCode === 200 ? first : second;
  const self = winner === first ? alice : bob;
  expect((await winner.command("staff.role", self.userId, 1, { role: "SUPPORT" })).statusCode).toBe(409);
});

it("separates invitations and customer authentication, while preserving the last ready ADMIN", async () => {
  const invited = await first.command("staff.invite", "invite@example.invalid", 0, { email: "invite@example.invalid", role: "SUPPORT" });
  expect(invited.statusCode).toBe(200);
  const token = invited.json().invitationToken;
  expect(typeof token).toBe("string");
  expect(JSON.stringify(await prisma.adminCommand.findMany())).not.toContain(token);
  const accept = () => app.inject({ method: "POST", url: "/api/auth/invitations/accept",
    headers: { origin: env.ADMIN_ORIGIN }, payload: { token, password: PASSWORD } });
  expect((await Promise.all([accept(), accept()])).map(res => res.statusCode).sort()).toEqual([204, 400]);
  expect(await prisma.authIdentity.count({ where: { providerId: "invite@example.invalid" } })).toBe(0);
  const publicApp = await buildApp();
  try {
    const staff = await prisma.user.findUniqueOrThrow({ where: { email: "invite@example.invalid" } });
    await expect(createSession(staff, {})).rejects.toMatchObject({ code: "ACCOUNT_BLOCKED" });
    const token = (await createSession(await createUser(), {})).accessToken;
    expect((await app.inject({ url: "/api/me", cookies: { vpn_at: token } })).statusCode).toBe(401);
    expect((await publicApp.inject({ url: "/api/staff" })).statusCode).toBe(404);
  } finally { await publicApp.close(); }
});

it("linearizes offer publishing with two admins", async () => {
  const plan = await prisma.plan.create({ data: bodyOf });
  const responses = await Promise.all([
    first.command("plan.publish", plan.id, 0, offer),
    second.command("plan.publish", plan.id, 0, { ...offer, amountMinor: 20000 }),
  ]);
  expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
  expect(await prisma.offerVersion.count()).toBe(1);
  expect((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).revision).toBe(1);
});

it("keeps independent holds, rejects old revision requeue and leaves the ledger unchanged", async () => {
  const user = await createUser();
  const { order } = await paidOrder(user.id);
  const initial = await prisma.subscription.findUniqueOrThrow({ where: { userId: user.id } });
  const oldest = await prisma.fulfillmentJob.findFirstOrThrow({ where: { assignment: { subscriptionId: initial.id } } });
  const created = await Promise.all([
    first.command("user.hold", user.id, initial.revision, { kind: "ADMIN" }),
    second.command("user.hold", user.id, initial.revision, { kind: "FRAUD" }),
  ]);
  expect(created.map(r => r.statusCode).sort()).toEqual([200, 409]);
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: user.id } });
  const extra = await second.command("user.hold", user.id, sub.revision, { kind: "FRAUD" });
  expect(extra.statusCode).toBe(200);
  const releases = await Promise.all([first, second].map(client =>
    client.command("user.release_hold", user.id, sub.revision, { holdId: extra.json().result.holdId })));
  expect(releases.some(r => r.statusCode === 200)).toBe(true);
  expect(await prisma.serviceHold.count({ where: { subscriptionId: sub.id, releasedAt: null } })).toBe(1);
  expect((await first.command("job.requeue", oldest.id, initial.revision, {})).json().error.code).toBe("STALE_REVISION");
  expect((await first.command("order.reconcile", order.id, order.updatedAt.toISOString(), {})).statusCode).toBe(200);
  expect(await prisma.paymentCase.count({ where: { kind: "MANUAL_RECONCILIATION" } })).toBe(1);
  expect(await prisma.paymentTransaction.count()).toBe(1);
});

it("reserves confirmed refunds once, requires an independent approver and never emits a financial movement", async () => {
  const { order, capture } = await paidOrder((await createUser()).id);
  const version = order.updatedAt.toISOString();
  await financeFact(capture.accountId, "REFUND", 1000n, "RUB", capture.movementKey, capture.paymentId!);
  const request = { captureId: capture.id, amountMinor: "6000", currency: "RUB" };
  const concurrent = await Promise.all([
    first.command("refund.request", order.id, version, request), second.command("refund.request", order.id, version, request),
  ]);
  expect(concurrent.map(response => response.statusCode).sort()).toEqual([200, 409]);
  const winner = concurrent[0]!.statusCode === 200 ? first : second;
  const approver = winner === first ? second : first;
  const refundId = concurrent.find(response => response.statusCode === 200)!.json().result.refundId;
  expect((await winner.command("refund.approve", order.id, version, { refundId })).json().error.code).toBe("SAME_APPROVER");
  const outcomes = await Promise.all([
    approver.command("refund.approve", order.id, version, { refundId }),
    approver.command("refund.approve", order.id, version, { refundId }),
  ]);
  expect(outcomes.map(result => result.statusCode).sort()).toEqual([200, 409]);
  expect(outcomes.find(result => result.statusCode === 200)!.json().result.status).toBe("APPROVED_WAITING_PROVIDER");
  expect(await prisma.refundIntent.count()).toBe(1);
  expect(await prisma.paymentTransaction.count()).toBe(2);
});

it("appends one traced time credit per approved incident with no order or financial record", async () => {
  const buyer = await createUser();
  const { grant } = await paidOrder(buyer.id);
  const command = { affectedPeriodId: grant.id, durationSeconds: 3600, incidentId: "support-incident" };
  expect((await first.command("subscription.compensate", buyer.id, 1, command)).json().error.code).toBe("COMPENSATION_POLICY_PENDING");
  process.env.ADMIN_COMPENSATION_POLICY = "incident-append-v1";
  try {
    const credit = await first.command("subscription.compensate", buyer.id, 1, command);
    expect(credit.statusCode).toBe(200);
    expect((await prisma.periodGrant.findUniqueOrThrow({ where: { id: credit.json().result.id } })))
      .toMatchObject({ basisGrantId: grant.id, orderId: null, allocationId: null, startAt: grant.endAt });
    expect((await second.command("subscription.compensate", buyer.id, credit.json().result.revision, command)).json().error.code)
      .toBe("INCIDENT_ALREADY_COMPENSATED");
    expect(await prisma.paymentTransaction.count()).toBe(1);
  } finally { delete process.env.ADMIN_COMPENSATION_POLICY; }
});
