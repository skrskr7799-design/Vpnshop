import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createOrder, createUser } from "../../test/factories";
import { createSession, revokeSessionFamily } from "../auth/session.service";
import { dbNow } from "../commerce/offers";
import { recordLookup } from "../payments/ledger";
import { allocateCapture } from "../subscriptions/allocation";
import { placeStaffHold } from "../subscriptions/holds";

let app: FastifyInstance;
beforeEach(async () => { await resetDatabase(); app = await buildApp(); });
afterEach(async () => { await app.close(); });
const get = (url: string, token: string) => app.inject({ url, cookies: { vpn_at: token } });

it("binds cursors to their owner and prevents BOLA across orders, payments and subscriptions", async () => {
  const first = await createUser();
  const next = await createUser();
  const owner = await createSession(first, {});
  const stranger = await createSession(next, {});
  const order = await createOrder(first.id);
  await createOrder(first.id);
  const pay = await prisma.payment.create({ data: { orderId: order.id, provider: "PLATEGA", amount: order.amount, currency: order.currency,
    providerData: { secret: "private-provider-payload" } } });
  const history = await get("/api/orders?limit=1", owner.accessToken);
  expect(history.statusCode).toBe(200);
  expect(history.headers["cache-control"]).toBe("private, no-store");
  const { items, nextCursor } = history.json();
  expect(items).toHaveLength(1);
  expect(nextCursor).toBeTruthy();
  const nextPage = await get(`/api/orders?limit=1&cursor=${encodeURIComponent(nextCursor)}`, owner.accessToken);
  expect(nextPage.json().items[0].id).not.toBe(items[0].id);
  expect((await get(`/api/orders?cursor=${encodeURIComponent(nextCursor)}`, stranger.accessToken)).statusCode).toBe(400);
  for (const path of [`/api/orders/${order.id}`, `/api/orders/${order.id}/payments`, `/api/orders/${order.id}/payments/${pay.id}`]) {
    expect((await get(path, stranger.accessToken)).statusCode).toBe(404);
  }
  expect((await get(`/api/orders/${order.id}/payments`, owner.accessToken)).body).not.toContain("private-provider-payload");
  await prisma.subscription.create({ data: { userId: first.id } });
  expect((await get("/api/me/subscription", stranger.accessToken)).json().subscription).toBeNull();
  expect((await get("/api/me/subscription/periods", stranger.accessToken)).json().items).toEqual([]);
  await revokeSessionFamily(owner.refreshToken);
  expect((await get("/api/orders", owner.accessToken)).statusCode).toBe(401);
});

async function orderWithPayment(deviceId: string) {
  const merchant = await prisma.merchantAccount.create({ data: { provider: "PLATEGA", environment: "MOCK", merchant: randomUUID() } });
  const plan = await prisma.plan.create({ data: { code: randomUUID(), name: "Test", deviceLimit: 5 } });
  const createdAt = await dbNow(prisma);
  const price = await prisma.planPrice.create({ data: { planId: plan.id, amount: 10000, durationMonths: 1, currency: "RUB" } });
  const version = await prisma.offerVersion.create({ data: {
    planPriceId: price.id, version: 1, name: plan.name, amount: 10000, durationMonths: 1, currency: "RUB",
    deviceLimit: 5, publishedAt: createdAt,
  } });
  const order = await prisma.order.create({ data: {
    userId: deviceId, planId: plan.id, amount: 10000, durationMonths: 1, deviceLimit: 5, currency: "RUB",
    offerVersionId: version.id, checkoutKeyHash: randomUUID(), checkoutPolicyVersion: 1, createdAt,
    expiresAt: new Date(+createdAt + 30 * 60_000),
  } });
  const payment = await prisma.payment.create({ data: {
    orderId: order.id, accountId: merchant.id, provider: merchant.provider, merchantReference: randomUUID(),
    externalId: randomUUID(), requestKeyHash: randomUUID(), channel: "SBP", amount: order.amount,
    currency: order.currency, expiresAt: order.expiresAt, status: "UNKNOWN",
  } });
  return { order, capture: async (time: Date) => {
    const key = randomUUID();
    await recordLookup(merchant, { status: "CONFIRMED", externalPaymentId: payment.externalId!, merchantReference: payment.merchantReference,
      movement: { key, kind: "CAPTURE", amountMinor: "10000", currency: "RUB", providerTime: time.toISOString(), originalMovementKey: null } });
    return prisma.paymentTransaction.findUniqueOrThrow({ where: { accountId_movementKey: { accountId: merchant.id, movementKey: key } } });
  } };
}

it("separates unknown/late money, allocated rights, pending fulfillment and holds", async () => {
  const user = await createUser();
  const token = (await createSession(user, {})).accessToken;
  const admin = await prisma.user.create({ data: { role: "ADMIN" } });
  const late = await orderWithPayment(user.id);
  const lateUrl = `/api/orders/${late.order.id}`;
  expect((await get(lateUrl, token)).json().moneyStatus).toBe("UNKNOWN");
  await late.capture(late.order.expiresAt);
  expect((await get(lateUrl, token)).json()).toMatchObject({ moneyStatus: "LATE_CAPTURE", deliveryStatus: "NOT_REQUESTED" });
  const paid = await orderWithPayment(user.id);
  const fact = await paid.capture(await dbNow(prisma));
  expect((await allocateCapture(fact.id)).status).toBe("ALLOCATED");
  expect((await get(`/api/orders/${paid.order.id}`, token)).json())
    .toMatchObject({ orderState: "ALLOCATED", moneyStatus: "CAPTURE_RECORDED", deliveryStatus: "WAITING", canStartPayment: false });
  expect((await get("/api/me/subscription", token)).json().subscription)
    .toMatchObject({ rightStatus: "ACTIVE", delivery: { status: "WAITING" } });
  await placeStaffHold(user.id, admin.id, "case", "ADMIN", "Test");
  expect((await get("/api/me/subscription", token)).json().subscription.rightStatus).toBe("HELD");
  const access = await app.inject({ method: "POST", url: "/api/me/subscription/access", headers: { origin: env.WEB_ORIGIN },
    cookies: { vpn_at: token }, payload: {} });
  expect(access.statusCode).toBe(503);
  expect(access.body).not.toContain("subscriptionUrl");
  expect(access.headers["referrer-policy"]).toBe("no-referrer");
});
