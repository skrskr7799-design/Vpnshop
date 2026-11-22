import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { catalogSchema, checkoutResponseSchema, orderDetailSchema } from "@vpn/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createOrder, createUser } from "../../test/factories";
import { as, buildTestAdminApp, createEnrolledAdmin } from "../admin/admin.test-helpers";
import { ACCESS_COOKIE } from "../auth/auth.constants";
import { createSession } from "../auth/session.service";

let app: FastifyInstance;
let adminApp: FastifyInstance;
let admin: ReturnType<typeof as>;
let planId: string;
let buyer: Awaited<ReturnType<typeof customer>>;

async function customer() {
  const user = await createUser();
  const { accessToken } = await createSession(user, {});
  return { user, cookies: { [ACCESS_COOKIE]: accessToken } };
}
beforeEach(async () => {
  await resetDatabase();
  [app, adminApp] = await Promise.all([buildApp(), buildTestAdminApp()]);
  const staff = await createEnrolledAdmin("admin@example.com", "ADMIN");
  admin = as(adminApp, staff.sessionToken);
  const plan = await admin.command("plan.create", "pro", 0, { code: "pro", name: "Pro", deviceLimit: 5 });
  expect(plan.statusCode).toBe(200);
  planId = plan.json().result.id;
  buyer = await customer();
});
afterEach(async () => { await Promise.all([app?.close(), adminApp?.close()]); });

const planRevision = async () => (await prisma.plan.findUniqueOrThrow({ where: { id: planId } })).revision;
const price = async (amountMinor = 19000, options: Record<string, unknown> = {}) =>
  admin.command("plan.publish", planId, await planRevision(), { name: "Pro", deviceLimit: 5,
    amountMinor, currency: "RUB", durationMonths: 1, ...options });
async function publish(amount?: number, options?: Record<string, unknown>) {
  const res = await price(amount, options);
  expect(res.statusCode).toBe(200);
  const published = res.json().result as { id: string; priceId: string };
  expect(published.id).toBeTruthy();
  return { id: published.priceId, offerVersionId: published.id };
}
const retire = async (offerId: string) => admin.command("plan.retire_offer", planId, await planRevision(), { offerId });
const buy = (offerVersionId: string, key = randomUUID() as string, customer = buyer, extra = {}) =>
  app.inject({ method: "POST", url: "/api/orders", cookies: customer.cookies,
    headers: { origin: env.WEB_ORIGIN, "Idempotency-Key": key }, payload: { offerVersionId, ...extra } });

async function catalog(query = "") {
  const response = await app.inject({ url: `/api/plans${query}` });
  expect(response.statusCode).toBe(200);
  return catalogSchema.parse(response.json()).offers;
}

it("publishes, versions edits and exposes only current offers in a deterministic order", async () => {
  expect(await catalog()).toEqual([]);
  const first = await publish();
  const repeat = await publish();
  expect(repeat).toEqual(first);

  const sixMonths = await publish(80000, { durationMonths: 6 });
  const threeMonths = await publish(50000, { durationMonths: 3 });
  const usd = await publish(250, { currency: "USD" });
  const second = await publish(21000);
  expect(second.id).toBe(first.id);
  expect(second.offerVersionId).not.toBe(first.offerVersionId);
  expect((await catalog()).map(offer => offer.id)).toEqual([
    second.offerVersionId, usd.offerVersionId, threeMonths.offerVersionId, sixMonths.offerVersionId,
  ]);
  expect(await catalog("?currency=USD")).toMatchObject([{ id: usd.offerVersionId, price: { amountMinor: 250, currency: "USD" } }]);
  expect((await app.inject({ url: "/api/plans?currency=EUR" })).statusCode).toBe(400);
  expect((await buy(first.offerVersionId)).json()).toMatchObject({ error: { code: "OFFER_CHANGED" } });
  const history = (await admin.get(`/api/plans/${planId}/versions`)).json().items.filter((row: { planPriceId: string }) => row.planPriceId === first.id);
  expect(history).toMatchObject([
    { version: 2, amount: 21000, withdrawnAt: null },
    { version: 1, amount: 19000, withdrawnAt: expect.any(String) },
  ]);
  expect(await prisma.auditLog.count({ where: { action: "plan.publish" } })).toBe(6);
});

it("preserves snapshot and checkout key across price, name, limit and withdrawal", async () => {
  const first = await publish();
  const key = randomUUID();
  const res = await buy(first.offerVersionId, key);
  expect(res.statusCode).toBe(201);
  const purchased = checkoutResponseSchema.parse(res.json());
  expect(res.headers["cache-control"]).toBe("private, no-store");
  const elapsed = Date.parse(purchased.expiresAt) - Date.parse(purchased.snapshot.snapshottedAt);
  expect(elapsed).toBe(env.CHECKOUT_TTL_MINUTES * 60_000);
  await publish(19000, { name: "Pro Plus", deviceLimit: 9 });
  const [changed] = await catalog();
  expect(changed).toMatchObject({ version: 2, name: "Pro Plus", deviceLimit: 9 });
  const second = await publish(28000);
  expect((await retire(second.offerVersionId)).statusCode).toBe(200);
  expect(await catalog()).toEqual([]);
  expect((await buy(second.offerVersionId)).json().error.code).toBe("OFFER_UNAVAILABLE");

  // The original HTTP result may be lost after commit. Retry precedes the offer check.
  const replay = await buy(first.offerVersionId.toUpperCase(), key);
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(purchased);
  expect(purchased.snapshot).toMatchObject({ version: 1, name: "Pro", planId, deviceLimit: 5, price: { amountMinor: 19000, currency: "RUB" } });
  const detail = await app.inject({ url: `/api/orders/${purchased.orderId}`, cookies: buyer.cookies });
  expect(orderDetailSchema.parse(detail.json()).snapshot).toEqual(purchased.snapshot);
  expect(await prisma.order.count()).toBe(1);
  await expect(prisma.order.update({ where: { id: purchased.orderId }, data: { amount: 1 } })).rejects.toThrow("Order snapshot is immutable");
  await expect(prisma.offerVersion.update({ where: { id: first.offerVersionId }, data: { deviceLimit: 2 } }))
    .rejects.toThrow("Published offer terms are immutable");
});

it("validates the request and isolates owners and operation keys", async () => {
  const first = await publish();
  const other = await customer();
  const key = randomUUID();
  const { offerVersionId } = first;
  expect((await buy(offerVersionId, key, buyer, { price: 1, currency: "USD", userId: other.user.id })).statusCode).toBe(400);
  expect((await buy(offerVersionId, "short")).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: "/api/orders", payload: { offerVersionId },
    headers: { origin: env.WEB_ORIGIN, "Idempotency-Key": key } })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url: "/api/orders", payload: { offerVersionId }, cookies: buyer.cookies,
    headers: { "Idempotency-Key": key } })).statusCode).toBe(403);
  const order = checkoutResponseSchema.parse((await buy(offerVersionId, key)).json());
  const otherOrder = checkoutResponseSchema.parse((await buy(offerVersionId, key, other)).json());
  expect(otherOrder.orderId).not.toBe(order.orderId);
  expect((await app.inject({ url: `/api/orders/${order.orderId}`, cookies: other.cookies })).statusCode).toBe(404);
  expect(await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).toMatchObject({ userId: buyer.user.id });
  const legacy = await createOrder(buyer.user.id);
  const detail = await app.inject({ url: `/api/orders/${legacy.id}`, cookies: buyer.cookies });
  expect(orderDetailSchema.parse(detail.json()).snapshot).toMatchObject({
    offerId: null, offerVersionId: null, version: null, name: null, policyVersion: null, price: { amountMinor: legacy.amount },
  });
});

it("serializes identical and conflicting checkout requests, with separate keys creating separate orders", async () => {
  const first = await publish();
  const second = await publish(100, { durationMonths: 3 });
  const identicalKey = randomUUID();
  const same = await Promise.all(Array.from({ length: 4 }, () => buy(first.offerVersionId, identicalKey)));
  expect(same.map(res => res.statusCode)).toEqual([201, 201, 201, 201]);
  expect(new Set(same.map(res => res.json().orderId)).size).toBe(1);
  const key = randomUUID();
  const conflicting = await Promise.all([buy(first.offerVersionId, key), buy(second.offerVersionId, key)]);
  expect(conflicting.map(res => res.statusCode).sort()).toEqual([201, 409]);
  const winnerVersion = conflicting.find(res => res.statusCode === 201)!.json().snapshot.offerVersionId;
  const loser = winnerVersion === first.offerVersionId ? second.offerVersionId : first.offerVersionId;
  expect((await buy(loser, key)).json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  expect((await buy(winnerVersion, key)).statusCode).toBe(201);
  const independent = await Promise.all([buy(first.offerVersionId), buy(first.offerVersionId)]);
  expect(independent.map(res => res.statusCode)).toEqual([201, 201]);
  expect(independent[0]!.json().orderId).not.toBe(independent[1]!.json().orderId);
  expect(await prisma.order.count()).toBe(4);
});

it.each(["publish", "withdraw"] as const)("linearizes %s and checkout around one plan row", async action => {
  const first = await publish();
  const key = randomUUID();
  const [order, mutation] = await Promise.all([
    buy(first.offerVersionId, key),
    action === "publish" ? price(24000) : retire(first.offerVersionId),
  ]);
  expect(mutation.statusCode).toBe(200);
  if (order.statusCode === 201) {
    expect(checkoutResponseSchema.parse(order.json()).snapshot.price.amountMinor).toBe(19000);
    expect((await buy(first.offerVersionId, key)).json()).toEqual(order.json());
  } else {
    expect(order.statusCode).toBe(409);
    expect(await prisma.order.count()).toBe(0);
    if (action === "publish") {
      const changed = mutation.json().result.id;
      const retried = await buy(changed, key);
      expect(retried.statusCode).toBe(201);
      expect(retried.json().snapshot.price.amountMinor).toBe(24000);
    }
  }
  expect((await buy(first.offerVersionId)).statusCode).toBe(409);
});

it("disables the whole plan, keeps published history and preserves SUPPORT read-only access", async () => {
  const published = await publish();
  const staff = await createEnrolledAdmin("support@example.com", "SUPPORT");
  const support = as(adminApp, staff.sessionToken);
  expect((await support.get("/api/plans")).statusCode).toBe(200);
  expect((await support.command("plan.publish", planId, await planRevision(), {
    name: "Changed", deviceLimit: 3, durationMonths: 1, currency: "RUB", amountMinor: 200,
  })).statusCode).toBe(403);
  expect((await support.command("plan.retire_offer", planId, await planRevision(), { offerId: published.offerVersionId })).statusCode).toBe(403);
  expect((await admin.delete(`/api/plans/${planId}`)).statusCode).toBe(404);
  expect((await admin.command("plan.retire", planId, await planRevision(), {})).statusCode).toBe(200);
  expect(await catalog()).toEqual([]);
  expect((await buy(published.offerVersionId)).json().error.code).toBe("OFFER_UNAVAILABLE");
  expect(await prisma.offerVersion.count()).toBe(1);
  await admin.command("plan.update", planId, await planRevision(), { isActive: true });
  expect(await catalog()).toEqual([]);
  expect((await publish()).offerVersionId).not.toBe(published.offerVersionId);
});

it("rejects a blocked account holding a still-valid access token", async () => {
  const offer = await publish();
  await prisma.user.update({ where: { id: buyer.user.id }, data: { status: "BLOCKED" } });
  expect((await buy(offer.offerVersionId)).json().error.code).toBe("ACCOUNT_BLOCKED");
  expect(await prisma.order.count()).toBe(0);
});

it("enforces one current version and a matching order snapshot in PostgreSQL", async () => {
  const offer = await publish();
  const { id: _id, ...version } = await prisma.offerVersion.findUniqueOrThrow({ where: { id: offer.offerVersionId } });
  await expect(prisma.offerVersion.create({ data: { ...version, version: 2 } })).rejects.toMatchObject({ code: "P2002" });
  await expect(prisma.order.create({ data: {
    planId, userId: buyer.user.id, offerVersionId: offer.offerVersionId,
    durationMonths: 1, deviceLimit: 5, currency: "RUB", amount: 1, expiresAt: new Date(),
    checkoutKeyHash: "test-key", checkoutPolicyVersion: 1,
  } })).rejects.toThrow("Order snapshot does not match offer version");
});

it("releases a checkout key when the insert rolls back", async () => {
  const { checkout } = await import("./orders");
  const offer = await publish();
  const userId = randomUUID();
  const key = randomUUID();
  // Simulates an account being removed before the insert: PostgreSQL rejects the stale FK.
  await expect(checkout(userId, key, offer.offerVersionId)).rejects.toMatchObject({ code: "P2003" });
  expect(await prisma.order.count()).toBe(0);
  await prisma.user.create({ data: { id: userId } });
  const retried = await checkout(userId, key, offer.offerVersionId);
  expect(retried.userId).toBe(userId);
  expect(await prisma.order.count()).toBe(1);
});
