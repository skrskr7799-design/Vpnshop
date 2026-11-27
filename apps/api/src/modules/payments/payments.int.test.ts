import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { paymentResponseSchema } from "@vpn/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { ACCESS_COOKIE } from "../auth/auth.constants";
import { createSession } from "../auth/session.service";
import { checkout } from "../commerce/orders";
import { acceptWebhook, processInbox } from "./inbox";
import { recordLookup } from "./ledger";
import type { Observation, PaymentMovement } from "./provider";
import { mockProvider } from "./provider.mock";
import { reconcileAttempts, runPaymentMaintenance } from "./reconciliation";
import { merchantAccount } from "./store";

const SECRET = "only-in-test";
let app: FastifyInstance;
let fixture: ReturnType<typeof mockProvider>;
let buyer: Awaited<ReturnType<typeof customer>>;
let account: Awaited<ReturnType<typeof merchantAccount>>;

async function customer() {
  const user = await createUser();
  const { accessToken } = await createSession(user, {});
  return { userId: user.id, cookies: { [ACCESS_COOKIE]: accessToken } };
}

beforeEach(async () => {
  await resetDatabase();
  fixture = mockProvider(SECRET);
  buyer = await customer();
  account = await merchantAccount(fixture.adapter);
  app = await buildApp({ payments: fixture.adapter });
});
afterEach(async () => { await app?.close(); });

async function order(currency: "RUB" | "USD" = "RUB") {
  const plan = await prisma.plan.create({ data: { code: randomUUID(), name: "Test", deviceLimit: 5 } });
  const price = await prisma.planPrice.create({
    data: { planId: plan.id, durationMonths: 1, currency, amount: 15000 },
  });
  const version = await prisma.offerVersion.create({ data: {
    planPriceId: price.id, version: 1, deviceLimit: 5, name: "Test", durationMonths: 1, currency,
    amount: price.amount, publishedAt: new Date(),
  } });
  return checkout(buyer.userId, randomUUID(), version.id);
}

function create(orderId: string, key: string = randomUUID(), channel = "SBP", user = buyer) {
  return app.inject({
    method: "POST", url: `/api/orders/${orderId}/payments`, cookies: user.cookies,
    payload: { channel }, headers: { origin: env.WEB_ORIGIN, "idempotency-key": key },
  });
}
async function newAttempt(orderId: string) {
  const response = await create(orderId);
  expect(response.statusCode, response.body).toBe(201);
  const result = paymentResponseSchema.parse(response.json());
  return prisma.payment.findUniqueOrThrow({ where: { id: result.attempt.id } });
}
function post(eventId: string, observation: Observation, secret = SECRET, merchant = account.merchant, environment = "MOCK") {
  return app.inject({
    method: "POST", url: `/webhooks/platega/${account.merchant}`, headers: { "x-fixture-secret": secret },
    payload: { eventId, observation, merchant, environment, privateProviderField: "not retained" },
  });
}
function capture(payment: Awaited<ReturnType<typeof newAttempt>>, movement: Partial<PaymentMovement> = {}): Observation {
  return {
    externalPaymentId: payment.externalId!, merchantReference: payment.merchantReference,
    status: "CONFIRMED", movement: {
      key: randomUUID(), kind: "CAPTURE", amountMinor: String(payment.amount), currency: payment.currency,
      providerTime: new Date().toISOString(), originalMovementKey: null, ...movement,
    },
  };
}
const caseExists = async (kind: string) => expect(await prisma.paymentCase.count({ where: { kind } })).toBeGreaterThan(0);
const fetchPayment = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const due = (id: string) => prisma.payment.update({ where: { id }, data: { nextCheckAt: new Date(0) } });

it("creates one invoice despite parallel identical requests and protects both owner endpoints", async () => {
  const local = await order();
  const key = randomUUID();
  const replies = await Promise.all([create(local.id, key), create(local.id, key)]);
  const results = replies.map(response => paymentResponseSchema.parse(response.json()));
  expect(new Set(results.map(result => result.attempt.id)).size).toBe(1);
  expect(fixture.sent).toEqual([expect.objectContaining({ amountMinor: 15000, currency: "RUB", channel: "SBP" })]);
  expect(results.some(result => result.nextAction.type === "REDIRECT")).toBe(true);
  expect(await prisma.payment.count()).toBe(1);
  expect((await create(local.id, key, "CARD")).json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  const other = await customer();
  expect((await create(local.id, randomUUID(), "SBP", other)).statusCode).toBe(404);
  const link = `/api/orders/${local.id}/payments/${results[0]!.attempt.id}`;
  expect((await app.inject({ url: link, cookies: other.cookies })).statusCode).toBe(404);
  const status = await app.inject({ url: link, cookies: buyer.cookies });
  expect(status.headers["cache-control"]).toBe("private, no-store");
  expect(paymentResponseSchema.parse(status.json()).attempt.status).toBe("AWAITING_CUSTOMER");
});

it("fails closed for default runtime, expired orders, wrong currency and an unsafe redirect", async () => {
  const local = await order();
  const disabled = await buildApp();
  try {
    const response = await disabled.inject({ method: "POST", url: `/api/orders/${local.id}/payments`, cookies: buyer.cookies,
      headers: { origin: env.WEB_ORIGIN, "idempotency-key": randomUUID() }, payload: { channel: "SBP" } });
    expect(response.json().error.code).toBe("PAYMENTS_DISABLED");
    expect((await disabled.inject({ method: "POST", url: "/webhooks/platega/mock-shop", payload: {} })).statusCode).toBe(404);
  } finally { await disabled.close(); }
  const usd = await order("USD");
  expect((await create(usd.id)).json().error.code).toBe("CHANNEL_UNAVAILABLE");
  const expired = await prisma.order.create({ data: {
    userId: local.userId, planId: local.planId, currency: local.currency, durationMonths: local.durationMonths,
    deviceLimit: local.deviceLimit, amount: local.amount, expiresAt: new Date(0),
    offerVersionId: local.offerVersionId, checkoutPolicyVersion: 1, checkoutKeyHash: randomUUID(),
  } });
  expect((await create(expired.id)).json().error.code).toBe("ORDER_CLOSED");
  expect(fixture.sent).toHaveLength(0);
  fixture.useCreateBehavior("bad-redirect");
  const result = paymentResponseSchema.parse((await create(local.id)).json());
  expect(result.attempt.status).toBe("UNKNOWN");
  expect(result.nextAction).toEqual({ type: "WAIT" });
});

it("keeps timeouts UNKNOWN, recovers the original invoice by lookup and never posts again", async () => {
  const local = await order();
  fixture.useCreateBehavior("timeout");
  const key = randomUUID();
  const response = await create(local.id, key);
  expect(response.statusCode).toBe(202);
  const unknown = paymentResponseSchema.parse(response.json());
  expect(unknown.attempt.status).toBe("UNKNOWN");
  expect((await create(local.id, key)).json().attempt.id).toBe(unknown.attempt.id);
  expect((await create(local.id)).json().error.code).toBe("ATTEMPT_IN_PROGRESS");
  const saved = await due(unknown.attempt.id);
  await reconcileAttempts(account, fixture.adapter);
  const recovered = await fetchPayment(saved.id);
  expect(recovered.status).toBe("AWAITING_CUSTOMER");
  expect(recovered.externalId).toBe(`invoice-${saved.merchantReference}`);
  expect(fixture.sent).toHaveLength(1);
  await caseExists("CREATE_OUTCOME_UNKNOWN");
});

it("recovers a stalled SUBMITTING intent without a provider search, and caches definitive rejection", async () => {
  const local = await order();
  fixture.useCreateBehavior("reject");
  const key = randomUUID();
  const rejected = paymentResponseSchema.parse((await create(local.id, key)).json());
  expect(rejected.attempt).toMatchObject({ status: "FAILED", reasonCode: "PROVIDER_REJECTED" });
  expect((await create(local.id, key)).json().attempt.id).toBe(rejected.attempt.id);
  expect(fixture.sent).toHaveLength(1);
  const stalled = await prisma.payment.update({ where: { id: rejected.attempt.id }, data: {
    status: "SUBMITTING", nextCheckAt: new Date(0),
  } });
  await reconcileAttempts(account, { ...fixture.adapter, findByMerchantReference: undefined });
  expect((await fetchPayment(stalled.id)).status).toBe("UNKNOWN");
  expect((await create(local.id)).json().error.code).toBe("ATTEMPT_IN_PROGRESS");
  expect(fixture.sent).toHaveLength(1);
});

it("commits authenticated replayable inbox data before ACK and tolerates lost ACK and restart", async () => {
  const local = await order();
  const payment = await newAttempt(local.id);
  const observation = capture(payment);
  expect((await post("event-1", observation, "invalid")).statusCode).toBe(401);
  expect((await post("event-1", observation, SECRET, account.merchant, "PRODUCTION")).statusCode).toBe(400);
  expect(await prisma.webhookEvent.count()).toBe(0);
  // Simulate process loss at the boundary after commit and before sending the HTTP response.
  await acceptWebhook(account, "event-1", observation);
  const replies = await Promise.all([post("event-1", observation), post("event-1", observation)]);
  expect(replies.map(reply => reply.statusCode)).toEqual([200, 200]);
  const persisted = await prisma.webhookEvent.findFirstOrThrow();
  expect(persisted).toMatchObject({ signatureValid: true, processedAt: null, payload: observation });
  expect(await prisma.webhookEvent.count()).toBe(1);
  expect(await prisma.paymentTransaction.count()).toBe(0);
  await app.close();
  app = await buildApp({ payments: fixture.adapter });
  await runPaymentMaintenance(account, fixture.adapter);
  expect(await prisma.paymentTransaction.count()).toBe(1);
  expect((await fetchPayment(payment.id)).status).toBe("SUCCEEDED");
  expect((await prisma.webhookEvent.findFirstOrThrow()).processedAt).not.toBeNull();
  expect((await prisma.order.findUniqueOrThrow({ where: { id: local.id } })).status).toBe("PENDING");
  expect(await prisma.fulfillmentJob.count()).toBe(0);
});

it("isolates event conflicts, bounds webhook size and reschedules unprocessed data", async () => {
  const payment = await newAttempt((await order()).id);
  const observation = capture(payment);
  const bad = await app.inject({ method: "POST", url: `/webhooks/platega/${account.merchant}`,
    headers: { "x-fixture-secret": SECRET }, payload: { data: "x".repeat(18000) } });
  expect(bad.statusCode).toBe(413);
  expect((await post("conflict", observation)).statusCode).toBe(200);
  expect((await post("conflict", { ...observation, movement: { ...observation.movement!, amountMinor: "1" } })).statusCode).toBe(200);
  await caseExists("EVENT_CONFLICT");
  expect(await prisma.webhookEvent.count()).toBe(1);
  expect((await prisma.webhookEvent.findFirstOrThrow()).payload).toEqual(observation);

  const persisted = await prisma.webhookEvent.findFirstOrThrow();
  await prisma.webhookEvent.update({ where: { id: persisted.id }, data: { payload: {} } });
  await processInbox(account);
  expect(await prisma.webhookEvent.findUnique({ where: { id: persisted.id } })).toMatchObject({ attempts: 1, processedAt: null });
  await caseExists("INBOX_PROCESSING_FAILED");
  expect(await prisma.paymentTransaction.count()).toBe(0);
});

it("deduplicates webhook and lookup across concurrent database transactions and rejects mutation", async () => {
  const sessions = await Promise.all([1, 2].map(() => prisma.$transaction(async db => {
    const [backend] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM pg_sleep(0.1)`;
    return backend!.pid;
  })));
  expect(new Set(sessions).size).toBe(2);
  const payment = await newAttempt((await order()).id);
  const observation = capture(payment);
  await post("separate-1", observation);
  await post("separate-2", observation);
  await Promise.all([processInbox(account), processInbox(account), recordLookup(account, observation)]);
  expect(await prisma.paymentTransaction.count()).toBe(1);
  const transaction = await prisma.paymentTransaction.findFirstOrThrow();
  await expect(prisma.paymentTransaction.update({ where: { id: transaction.id }, data: { amountMinor: 1n } }))
    .rejects.toThrow();
  await expect(prisma.paymentTransaction.delete({ where: { id: transaction.id } })).rejects.toThrow();
  await recordLookup(account, { ...observation, status: "FAILED", movement: null });
  await caseExists("LOOKUP_CONTRADICTION");
  expect((await fetchPayment(payment.id)).status).toBe("SUCCEEDED");
});

it("records mismatches and unmatched movements while leaving the order and access untouched", async () => {
  const local = await order();
  const payment = await newAttempt(local.id);
  const wrongAmount = capture(payment, { amountMinor: "1" });
  const wrongCurrency = capture(payment, { currency: "EUR" });
  const unknown = { ...capture(payment), externalPaymentId: "elsewhere" };
  await Promise.all([post("amount", wrongAmount), post("currency", wrongCurrency), post("unknown", unknown)]);
  await processInbox(account);
  await caseExists("AMOUNT_MISMATCH");
  await caseExists("CURRENCY_MISMATCH");
  await caseExists("PAYMENT_IDENTITY_MISMATCH");
  expect(await prisma.paymentTransaction.count()).toBe(3);
  expect(await prisma.paymentTransaction.findFirst({ where: { externalPaymentId: "elsewhere" } })).toMatchObject({ paymentId: null });
  expect((await fetchPayment(payment.id)).status).toBe("AWAITING_CUSTOMER");
  expect((await prisma.order.findUniqueOrThrow({ where: { id: local.id } })).status).toBe("PENDING");
  expect(await prisma.fulfillmentJob.count()).toBe(0);
});

it("records two real captures, including one after the payment window", async () => {
  const local = await order();
  const payment = await newAttempt(local.id);
  // An independently verified extra capture can use the same invoice ID and a distinct movement ID.
  const late = capture(payment, { providerTime: local.expiresAt.toISOString() });
  await Promise.all([post("capture-1", capture(payment)), post("capture-2", late)]);
  await Promise.all([processInbox(account), processInbox(account)]);
  expect(await prisma.paymentTransaction.count({ where: { kind: "CAPTURE" } })).toBe(2);
  await caseExists("MULTIPLE_CAPTURES");
  await caseExists("LATE_OR_UNTIMED_CAPTURE");
  expect((await prisma.order.findUniqueOrThrow({ where: { id: local.id } })).status).toBe("PENDING");
  expect(await prisma.fulfillmentJob.count()).toBe(0);
});

it.each(["REFUND", "CHARGEBACK_DEBIT"] as const)("preserves %s received before capture and holds funds for review", async kind => {
  const payment = await newAttempt((await order()).id);
  const original = capture(payment);
  const reversal = capture(payment, { kind, originalMovementKey: original.movement!.key, amountMinor: "25" });
  await post("reversal", reversal);
  await processInbox(account);
  expect(await prisma.paymentTransaction.findFirst()).toMatchObject({
    kind, amountMinor: 25n, originalMovementKey: original.movement!.key,
  });
  expect(await prisma.paymentTransaction.count()).toBe(1);
  await caseExists("UNRESOLVED_REVERSAL");
  await Promise.all([recordLookup(account, original), post("original", original)]);
  await processInbox(account);
  await caseExists("REVERSAL_PRESENT");
  const transactions = await prisma.paymentTransaction.findMany();
  expect(transactions.map(row => row.kind).sort()).toEqual(["CAPTURE", kind].sort());
  expect(await prisma.fulfillmentJob.count()).toBe(0);
});

it("finds a missing webhook through due lookup, detects unknown status and stops without duplicate facts", async () => {
  const payment = await newAttempt((await order()).id);
  const confirmed = capture(payment);
  fixture.statuses.set(payment.externalId!, { ...confirmed, status: "UNKNOWN", movement: null });
  await due(payment.id);
  await reconcileAttempts(account, fixture.adapter);
  await caseExists("UNKNOWN_PROVIDER_STATUS");
  fixture.statuses.set(payment.externalId!, confirmed);
  await due(payment.id);
  await Promise.all([reconcileAttempts(account, fixture.adapter), reconcileAttempts(account, fixture.adapter)]);
  await caseExists("CAPTURE_DISCOVERED_BY_LOOKUP");
  await due(payment.id);
  await reconcileAttempts(account, fixture.adapter);
  expect(await prisma.paymentTransaction.count()).toBe(1);
  expect(await prisma.paymentCase.count({ where: { kind: "CAPTURE_DISCOVERED_BY_LOOKUP" } })).toBe(1);
});

it("closes only new payment admissions and still settles a prior attempt during maintenance", async () => {
  const acceptedOrder = await order();
  const blockedOrder = await order();
  const previousPayments = env.PAYMENTS_ENABLED;
  const previousMaintenance = env.MAINTENANCE_MODE;
  const key = randomUUID();
  try {
    const first = await create(acceptedOrder.id, key);
    expect(first.statusCode).toBe(201);
    const payment = await fetchPayment(first.json().attempt.id);
    env.PAYMENTS_ENABLED = false;
    expect((await create(blockedOrder.id)).json().error.code).toBe("PAYMENTS_DISABLED");
    env.MAINTENANCE_MODE = true;
    expect((await create(blockedOrder.id)).json().error.code).toBe("MAINTENANCE_MODE");
    expect((await create(acceptedOrder.id, key)).json().attempt.id).toBe(payment.id);
    const event = capture(payment);
    expect((await post("already-accepted", event)).statusCode).toBe(200);
    await processInbox(account);
    expect((await fetchPayment(payment.id)).status).toBe("SUCCEEDED");
    expect(await prisma.paymentTransaction.count()).toBe(1);
    expect(fixture.sent).toHaveLength(1);
  } finally {
    env.PAYMENTS_ENABLED = previousPayments;
    env.MAINTENANCE_MODE = previousMaintenance;
  }
});

it("rejects checkout and payment admission when the configured product cannot be provisioned", async () => {
  const local = await order();
  const previous = env.PAYMENTS_ENABLED;
  try {
    env.PAYMENTS_ENABLED = true;
    expect((await create(local.id)).json().error.code).toBe("PROVISIONING_UNAVAILABLE");
    const checkoutRequest = (key: string) => app.inject({
      method: "POST", url: "/api/orders", cookies: buyer.cookies,
      payload: { offerVersionId: local.offerVersionId }, headers: { origin: env.WEB_ORIGIN, "idempotency-key": key },
    });
    expect((await checkoutRequest(randomUUID())).json().error.code).toBe("PROVISIONING_UNAVAILABLE");
    expect(fixture.sent).toHaveLength(0);
    expect(await prisma.order.count()).toBe(1);
  } finally {
    env.PAYMENTS_ENABLED = previous;
  }
});
