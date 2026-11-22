import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../app";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { as, buildTestAdminApp, PASSWORD } from "../modules/admin/admin.test-helpers";
import { createAdminUser } from "../modules/admin/auth/admin-auth.service";
import { currentCode } from "../modules/admin/auth/totp";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "../modules/auth/auth.constants";
import { createSession } from "../modules/auth/session.service";
import { dbNow } from "../modules/commerce/offers";
import { processRevision } from "../modules/fulfillment/revision.processor";
import { claimRevision } from "../modules/fulfillment/revision.queue";
import { sendMail } from "../modules/mail/mail.service";
import { runPaymentMaintenance } from "../modules/payments/reconciliation";
import { mockProvider } from "../modules/payments/provider.mock";
import { merchantAccount } from "../modules/payments/store";
import { allocateCapture } from "../modules/subscriptions/allocation";
import { resetDatabase } from "./db";
import { createUser } from "./factories";
import { mockPanel, secret } from "./revision-panel";

vi.mock("../modules/mail/mail.service", () => ({ sendMail: vi.fn(async () => {}) }));
afterEach(() => vi.unstubAllEnvs());

it("rehearses customer and staff journeys through public/admin HTTP with durable financial and fulfillment effects", async () => {
  await resetDatabase();
  vi.stubEnv("REMNAWAVE_REVISION_MODE", "staging");
  vi.stubEnv("REMNAWAVE_STAGING_ORIGIN", "https://panel.example.invalid");
  vi.stubEnv("REMNAWAVE_STAGING_LINK_ORIGIN", "https://links.example.invalid");
  vi.stubEnv("REMNAWAVE_STAGING_TOKEN", "isolated-fixture");
  vi.stubEnv("REMNAWAVE_STAGING_INSTANCE", "staging-test");
  vi.stubEnv("REMNAWAVE_STAGING_SQUADS", "11111111-1111-4111-8111-111111111111");

  const payments = mockProvider();
  const panel = mockPanel();
  const publicApi = await buildApp({ payments: payments.adapter, panel: panel.panel });
  const adminApi = await buildTestAdminApp();
  const cookies: Record<string, string> = {};
  const origin = env.WEB_ORIGIN;
  const post = (url: string, payload: object, key = randomUUID()) =>
    publicApi.inject({ method: "POST", url, payload, cookies, headers: { origin, "idempotency-key": key } });
  const read = (url: string) => publicApi.inject({ url, cookies });
  const adminPost = (url: string, payload: object) =>
    adminApi.inject({ method: "POST", url, payload, headers: { origin: env.ADMIN_ORIGIN } });

  async function staff(email: string, role: "ADMIN" | "SUPPORT") {
    await createAdminUser({ email, password: PASSWORD, role });
    const password = await adminPost("/api/auth/login", { email, password: PASSWORD });
    expect(password.statusCode).toBe(200);
    expect(password.cookies).toHaveLength(0);
    const { stageToken } = password.json();
    const setup = await adminPost("/api/auth/2fa/enroll/start", { stageToken });
    expect(setup.statusCode).toBe(200);
    const valid = await adminPost("/api/auth/2fa/enroll/confirm", { stageToken, code: currentCode(setup.json().secret) });
    expect(valid.statusCode).toBe(200);
    const cookie = valid.cookies.find(item => item.name === "vpn_admin");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict" });
    return as(adminApi, cookie!.value);
  }

  try {
    const operator = await staff("staff-release@example.invalid", "ADMIN");
    const approver = await staff("approver-release@example.invalid", "ADMIN");
    const support = await staff("support-release@example.invalid", "SUPPORT");
    const planCreated = await operator.command("plan.create", "release", 0, { code: "release", name: "Release fixture", deviceLimit: 5 });
    expect(planCreated.statusCode).toBe(200);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: "release" } });
    const offer = { name: "Release fixture", amountMinor: 15000, durationMonths: 1, deviceLimit: 5, currency: "RUB" };
    expect((await operator.command("plan.publish", plan.id, plan.revision, offer)).statusCode).toBe(200);
    expect((await operator.command("plan.publish", plan.id, plan.revision, offer)).json().error.code).toBe("VERSION_CONFLICT");

    const email = "customer-release@example.invalid";
    const password = "release-only-testing-password";
    expect((await post("/api/auth/register", { email, password })).statusCode).toBe(202);
    expect(await prisma.pendingRegistration.count({ where: { email } })).toBe(1);
    const mail = vi.mocked(sendMail).mock.calls.find(([, message]) => message.to === email)?.[1];
    expect(mail).toBeTruthy();
    const link = mail!.text.match(/https?:\/\/\S+/)![0];
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
    expect((await post("/api/auth/verify-email", { token })).statusCode).toBe(204);
    expect((await post("/api/auth/verify-email", { token })).statusCode).toBe(400);
    const login = await post("/api/auth/login", { email, password });
    expect(login.statusCode).toBe(200);
    for (const cookie of login.cookies) cookies[cookie.name] = cookie.value;
    expect(login.cookies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: ACCESS_COOKIE, httpOnly: true, sameSite: "Lax", path: "/" }),
      expect.objectContaining({ name: REFRESH_COOKIE, httpOnly: true, sameSite: "Lax", path: "/api/auth" }),
    ]));
    const customer = await prisma.user.findUniqueOrThrow({ where: { email } });
    const catalog = await read("/api/plans");
    expect(catalog.statusCode).toBe(200);
    const version = catalog.json().offers[0].id;
    const account = await merchantAccount(payments.adapter);

    async function purchase() {
      const key = randomUUID();
      const checkout = await post("/api/orders", { offerVersionId: version }, key);
      expect(checkout.statusCode).toBe(201);
      const orderId = checkout.json().orderId as string;
      expect((await post("/api/orders", { offerVersionId: version }, key)).json().orderId).toBe(orderId);
      const invoice = await post(`/api/orders/${orderId}/payments`, { channel: "SBP" });
      expect(invoice.statusCode).toBe(201);
      const attempt = await prisma.payment.findUniqueOrThrow({ where: { id: invoice.json().attempt.id } });
      const movementKey = randomUUID();
      const payload = { merchant: account.merchant, environment: "MOCK", eventId: randomUUID(), observation: {
        status: "CONFIRMED", externalPaymentId: attempt.externalId, merchantReference: attempt.merchantReference,
        movement: { kind: "CAPTURE", key: movementKey, amountMinor: "15000", currency: "RUB",
          providerTime: (await dbNow(prisma)).toISOString(), originalMovementKey: null },
      } };
      const ingest = (verified: boolean) => publicApi.inject({ method: "POST", url: `/webhooks/platega/${account.merchant}`, payload,
        headers: verified ? { "x-fixture-secret": "isolated-test-fixture" } : {} });
      expect((await ingest(false)).statusCode).toBe(401);
      expect(await prisma.webhookEvent.count({ where: { eventKey: payload.eventId } })).toBe(0);
      expect((await Promise.all([ingest(true), ingest(true)])).map(r => r.statusCode)).toEqual([200, 200]);
      expect(await prisma.webhookEvent.count({ where: { eventKey: payload.eventId } })).toBe(1);
      expect(await prisma.paymentTransaction.count({ where: { movementKey } })).toBe(0);
      await runPaymentMaintenance(account, payments.adapter);
      const fact = await prisma.paymentTransaction.findUniqueOrThrow({ where: { accountId_movementKey: { accountId: account.id, movementKey } } });
      expect(fact).toMatchObject({ amountMinor: 15000n, currency: "RUB", kind: "CAPTURE" });
      const allocated = await allocateCapture(fact.id);
      expect(allocated.status).toBe("ALLOCATED");
      const grant = await prisma.periodGrant.findFirstOrThrow({ where: { orderId } });
      await allocateCapture(fact.id);
      expect(await prisma.periodGrant.count({ where: { orderId } })).toBe(1);
      return { orderId, fact, grant };
    }

    const first = await purchase();
    expect((await read("/api/me/subscription")).json().subscription.delivery.status).toBe("WAITING");
    const work = await claimRevision("release-fixture-worker", 5000);
    expect(work).not.toBeNull();
    await processRevision(work!, panel.panel);
    expect(await prisma.panelObservation.count()).toBeGreaterThan(0);
    expect((await read("/api/me/subscription")).json().subscription.delivery.status).toBe("READY");
    const connection = await post("/api/me/subscription/access", {});
    expect(connection.statusCode).toBe(200);
    expect(connection.json().subscriptionUrl === secret).toBe(true);
    expect(connection.headers["cache-control"]).toBe("private, no-store");
    expect(connection.headers["referrer-policy"]).toBe("no-referrer");
    const stranger = await createSession(await createUser(), {});
    expect((await publicApi.inject({ url: `/api/orders/${first.orderId}`, cookies: { vpn_at: stranger.accessToken } })).statusCode).toBe(404);

    const renewal = await purchase();
    expect(renewal.grant.startAt).toEqual(first.grant.endAt);
    expect((await read("/api/me/subscription")).json().subscription.coverageEndsAt).toBe(renewal.grant.endAt.toISOString());
    const help = await post("/api/me/support/cases", { orderId: first.orderId, category: "DELIVERY", message: "Synthetic release question" });
    expect(help.statusCode).toBe(201);
    expect((await support.get("/api/payments/transactions")).statusCode).toBe(403);
    expect((await support.get("/api/support/cases/" + help.json().case.id)).statusCode).toBe(200);
    expect((await operator.get("/api/users/" + customer.id + "/periods")).json().items).toHaveLength(2);
    expect((await operator.get("/api/orders/" + first.orderId)).statusCode).toBe(200);
    const revision = (await prisma.subscription.findUniqueOrThrow({ where: { userId: customer.id } })).revision;
    expect((await operator.command("user.hold", customer.id, revision, { kind: "ADMIN" })).statusCode).toBe(200);
    expect((await post("/api/me/subscription/access", {})).json().error.code).toBe("ACCESS_HELD");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: first.orderId } });
    const refund = await operator.command("refund.request", order.id, order.updatedAt.toISOString(),
      { captureId: first.fact.id, amountMinor: "1000", currency: "RUB" });
    expect(refund.statusCode).toBe(200);
    const approval = { refundId: refund.json().result.refundId };
    expect((await operator.command("refund.approve", order.id, order.updatedAt.toISOString(), approval)).json().error.code).toBe("SAME_APPROVER");
    expect((await approver.command("refund.approve", order.id, order.updatedAt.toISOString(), approval)).json().result.status).toBe("APPROVED_WAITING_PROVIDER");

    expect((await post("/api/auth/logout", {})).statusCode).toBe(204);
    expect((await post("/api/auth/refresh", {})).statusCode).toBe(401);
    expect((await read("/api/orders")).statusCode).toBe(401);
    expect(await prisma.paymentTransaction.count()).toBe(2);
    expect(await prisma.orderAllocation.count()).toBe(2);
    expect(await prisma.periodGrant.count()).toBe(2);
    expect(await prisma.refundIntent.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "refund.approve" } })).toBe(1);
  } finally { await Promise.all([publicApi.close(), adminApi.close()]); }
});
