import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { MerchantAccount, PaymentTransaction } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createOrder, createUser } from "../../test/factories";
import { dbNow } from "../commerce/offers";
import { claimNextJob } from "../fulfillment/fulfillment.queue";
import { acceptWebhook, processInbox } from "../payments/inbox";
import { recordLookup } from "../payments/ledger";
import type { Observation } from "../payments/provider";
import { addMonths } from "../remnawave/remnawave.dates";
import { allocateCapture } from "./allocation";
import { placeStaffHold, releaseStaffHold } from "./holds";
import { applyReversal } from "./reversals";
import { createSubscription, lockSubscription, projectAssignment, refreshDueAssignments, subscriptionTransaction } from "./store";

let userId: string;
let account: MerchantAccount;
beforeEach(async () => {
  await resetDatabase();
  userId = (await createUser()).id;
  account = await merchant();
});

function merchant() {
  return prisma.merchantAccount.create({ data: { provider: "PLATEGA", environment: "MOCK", merchant: randomUUID() } });
}

async function offerOrder(options: {
  deviceLimit?: number; createdAt?: Date; months?: number; status?: "PENDING" | "EXPIRED";
} = {}) {
  const { deviceLimit = 5, months = 1, status = "PENDING" } = options;
  const createdAt = options.createdAt ?? await dbNow(prisma);
  const plan = await prisma.plan.create({ data: { code: randomUUID(), name: "Fixture", deviceLimit } });
  const price = await prisma.planPrice.create({
    data: { planId: plan.id, amount: 10000, durationMonths: months, currency: "RUB" },
  });
  const version = await prisma.offerVersion.create({ data: {
    planPriceId: price.id, version: 1, amount: price.amount, durationMonths: months, name: "Fixture",
    deviceLimit, currency: "RUB", publishedAt: createdAt,
  } });
  return prisma.order.create({ data: {
    userId, planId: plan.id, amount: price.amount, durationMonths: months, deviceLimit, currency: "RUB", status,
    offerVersionId: version.id, checkoutKeyHash: randomUUID(), checkoutPolicyVersion: 1, createdAt,
    expiresAt: new Date(createdAt.getTime() + 30 * 60_000),
  } });
}

async function fact(order: Awaited<ReturnType<typeof offerOrder>>, merchantAccount = account,
  input: { amountMinor?: string; currency?: string; providerTime?: Date } = {}) {
  const externalId = randomUUID();
  const merchantReference = randomUUID();
  await prisma.payment.create({ data: {
    orderId: order.id, provider: merchantAccount.provider, accountId: merchantAccount.id,
    amount: order.amount, currency: order.currency, status: "AWAITING_CUSTOMER",
    externalId, merchantReference, requestKeyHash: randomUUID(), channel: "SBP", expiresAt: order.expiresAt,
  } });
  const movementKey = randomUUID();
  await recordLookup(merchantAccount, {
    status: "CONFIRMED", externalPaymentId: externalId, merchantReference,
    movement: { key: movementKey, kind: "CAPTURE", amountMinor: input.amountMinor ?? String(order.amount),
      currency: input.currency ?? order.currency, providerTime: (input.providerTime ?? await dbNow(prisma)).toISOString(),
      originalMovementKey: null },
  });
  return prisma.paymentTransaction.findUniqueOrThrow({
    where: { accountId_movementKey: { accountId: merchantAccount.id, movementKey } },
  });
}

const booked = async (capture: PaymentTransaction) => {
  const result = await allocateCapture(capture.id);
  expect(result.status).toBe("ALLOCATED");
  if (result.status !== "ALLOCATED") throw new Error(result.reason);
  return result.grant;
};

async function reversalObservation(original: PaymentTransaction, kind: "REFUND" | "CHARGEBACK_DEBIT" | "CHARGEBACK_REVERSAL",
  amount = original.amountMinor, at?: Date): Promise<Observation> {
  return {
    status: "CONFIRMED", externalPaymentId: original.externalPaymentId, merchantReference: original.merchantReference,
    movement: {
      key: randomUUID(), kind, amountMinor: String(amount), currency: original.currency,
      providerTime: (at ?? await dbNow(prisma)).toISOString(), originalMovementKey: original.movementKey,
    },
  };
}

async function reverse(original: PaymentTransaction, kind: "REFUND" | "CHARGEBACK_DEBIT" | "CHARGEBACK_REVERSAL",
  amount = original.amountMinor, at?: Date) {
  const observation = await reversalObservation(original, kind, amount, at);
  await recordLookup(account, observation);
  return prisma.paymentTransaction.findUniqueOrThrow({ where: {
    accountId_movementKey: { accountId: account.id, movementKey: observation.movement!.key },
  } });
}

const current = () => prisma.desiredAssignment.findFirstOrThrow({
  where: { subscription: { userId } }, orderBy: { revision: "desc" },
});

it("books one allocation, grant, revision and queue item across concurrent calls and a lost response", async () => {
  const order = await offerOrder();
  const capture = await fact(order);
  const sameProof = await prisma.paymentTransaction.count();
  const results = await Promise.all([booked(capture), booked(capture)]);
  expect(results[0]).toEqual(results[1]);
  expect(await booked(capture)).toEqual(results[0]);
  expect(await prisma.paymentTransaction.count()).toBe(sameProof);
  expect(await prisma.orderAllocation.count()).toBe(1);
  expect(await prisma.periodGrant.count()).toBe(1);
  expect(await prisma.desiredAssignment.count()).toBe(1);
  const assignment = await current();
  expect(assignment).toMatchObject({ enabled: true, revision: 1, expiresAt: results[0]!.endAt, deviceLimit: 5 });
  expect(await prisma.fulfillmentJob.findFirst()).toMatchObject({ assignmentId: assignment.id, orderId: null, status: "PENDING" });
  expect(await claimNextJob("legacy-test", 3000)).toBeNull();
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING");
  expect(await prisma.auditLog.count({ where: { action: "subscription.allocate" } })).toBe(1);
});

it("serializes two paid renewals across merchant locks and independent PostgreSQL connections", async () => {
  const existing = await booked(await fact(await offerOrder()));
  const firstOrder = await offerOrder({ months: 3, deviceLimit: 8 });
  const secondOrder = await offerOrder({ months: 6, deviceLimit: 10 });
  const first = await fact(firstOrder);
  const second = await fact(secondOrder, await merchant());
  const connections = await Promise.all([0, 1].map(() => prisma.$transaction(async db => {
    const [row] = await db.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM pg_sleep(0.15)`;
    return row!.pid;
  })));
  expect(new Set(connections).size).toBe(2);
  const periods = (await Promise.all([booked(first), booked(second)])).sort((a, b) => a.serial - b.serial);
  const [left, right] = periods;
  expect(left).toMatchObject({ serial: 2, startAt: existing.endAt });
  expect(right).toMatchObject({ serial: 3, startAt: left!.endAt });
  for (const period of periods) {
    const duration = period.orderId === firstOrder.id ? firstOrder.durationMonths : secondOrder.durationMonths;
    expect(period.endAt).toEqual(addMonths(period.startAt, duration));
  }
  expect(right!.endAt).toBeGreaterThan(existing.endAt);
  expect((await current()).deviceLimit).toBe(5);
});

it("keeps a second capture unallocated and never adjusts the grant when those extra funds are refunded", async () => {
  const order = await offerOrder();
  await booked(await fact(order));
  const extra = await fact(order);
  expect(await allocateCapture(extra.id)).toMatchObject({ status: "REVIEW", reason: "CAPTURE_NOT_ALLOCATED" });
  const refund = await reverse(extra, "REFUND");
  expect(await applyReversal(refund.id)).toMatchObject({ status: "REVIEW", reason: "UNALLOCATED_REVERSAL" });
  expect(await prisma.periodGrant.count()).toBe(1);
  expect(await prisma.adjustment.count()).toBe(0);
  expect((await current()).enabled).toBe(true);
});

it.each(["expired", "late", "amount", "currency"] as const)("rejects %s evidence", async scenario => {
  const order = await offerOrder(scenario === "expired" ? { status: "EXPIRED" } : {});
  const capture = await fact(order, account, {
    providerTime: scenario === "late" ? order.expiresAt : undefined,
    amountMinor: scenario === "amount" ? "11" : undefined,
    currency: scenario === "currency" ? "EUR" : undefined,
  });
  expect((await allocateCapture(capture.id)).status).toBe("REVIEW");
  expect(await prisma.orderAllocation.count()).toBe(0);
  expect(await prisma.fulfillmentJob.count()).toBe(0);
});

it("blocks both pending and booked reversals even when the refund arrives before capture", async () => {
  const order = await offerOrder();
  const externalPaymentId = randomUUID();
  const merchantReference = randomUUID();
  const captureKey = randomUUID();
  await prisma.payment.create({ data: {
    orderId: order.id, provider: account.provider, accountId: account.id,
    status: "PROCESSING", externalId: externalPaymentId, merchantReference, requestKeyHash: randomUUID(),
    amount: order.amount, currency: order.currency, channel: "SBP", expiresAt: order.expiresAt,
  } });
  const providerTime = (await dbNow(prisma)).toISOString();
  await acceptWebhook(account, "refund-first", {
    status: "CONFIRMED", externalPaymentId, merchantReference,
    movement: { kind: "REFUND", key: randomUUID(), originalMovementKey: captureKey, amountMinor: String(order.amount),
      currency: order.currency, providerTime },
  });
  await recordLookup(account, {
    status: "CONFIRMED", externalPaymentId, merchantReference,
    movement: { kind: "CAPTURE", key: captureKey, originalMovementKey: null,
      amountMinor: String(order.amount), currency: order.currency, providerTime },
  });
  const capture = await prisma.paymentTransaction.findFirstOrThrow();
  expect(await allocateCapture(capture.id)).toMatchObject({ status: "REVIEW", reason: "INBOX_PENDING" });
  const [result] = await Promise.all([allocateCapture(capture.id), processInbox(account)]);
  expect(result.status).toBe("REVIEW");
  expect(await allocateCapture(capture.id)).toMatchObject({ status: "REVIEW", reason: "CAPTURE_REVERSED" });
  expect(await prisma.periodGrant.count()).toBe(0);
});

it("adds a full adjustment for an active grant and preserves a purchased future grant and gap", async () => {
  const firstCapture = await fact(await offerOrder());
  const first = await booked(firstCapture);
  const second = await booked(await fact(await offerOrder({ deviceLimit: 9 })));
  const refund = await reverse(firstCapture, "REFUND");
  const applied = await applyReversal(refund.id);
  expect(applied).toMatchObject({ status: "ADJUSTED", adjustment: { grantId: first.id, effectiveAt: refund.providerTime } });
  expect(await applyReversal(refund.id)).toEqual(applied);
  expect(await prisma.periodGrant.findUnique({ where: { id: first.id } })).toEqual(first);
  expect(await prisma.periodGrant.findUnique({ where: { id: second.id } })).toEqual(second);
  expect((await current())).toMatchObject({ enabled: false, nextBoundaryAt: second.startAt });
  expect(second.startAt).toEqual(first.endAt);
});

it("refunds a not-yet-started grant without changing the current one", async () => {
  const first = await booked(await fact(await offerOrder()));
  const secondCapture = await fact(await offerOrder({ deviceLimit: 8 }));
  const second = await booked(secondCapture);
  const refund = await reverse(secondCapture, "REFUND");
  expect(await applyReversal(refund.id)).toMatchObject({ status: "ADJUSTED", adjustment: { effectiveAt: second.startAt } });
  expect((await current())).toMatchObject({ enabled: true, grantId: first.id, expiresAt: first.endAt });
});

it("holds partial refunds for review and truncates only when confirmed refunds total the full capture", async () => {
  const capture = await fact(await offerOrder());
  const grant = await booked(capture);
  const partial = await reverse(capture, "REFUND", 5000n);
  expect(await applyReversal(partial.id)).toMatchObject({ status: "REVIEW", reason: "PARTIAL_REFUND_POLICY_REVIEW" });
  expect((await current()).expiresAt).toEqual(grant.endAt);
  expect(await prisma.adjustment.count()).toBe(0);
  const final = await reverse(capture, "REFUND", 5000n);
  expect(await applyReversal(final.id)).toMatchObject({ status: "ADJUSTED" });
  expect((await current()).enabled).toBe(false);
});

it("admits distinct hold reasons and releases only the confirmed chargeback on reversal", async () => {
  const capture = await fact(await offerOrder());
  await booked(capture);
  const staff = await createUser();
  await prisma.user.update({ where: { id: staff.id }, data: { role: "ADMIN" } });
  const denied = await createUser();
  await expect(placeStaffHold(userId, denied.id, "case-1", "FRAUD", "investigation")).rejects.toMatchObject({ statusCode: 403 });
  await placeStaffHold(userId, staff.id, "case-1", "FRAUD", "investigation");
  const debit = await reverse(capture, "CHARGEBACK_DEBIT");
  expect(await applyReversal(debit.id)).toMatchObject({ status: "HELD" });
  expect(await applyReversal(debit.id)).toMatchObject({ status: "HELD" });
  expect(await prisma.serviceHold.count()).toBe(2);
  const reversal = await reverse(debit, "CHARGEBACK_REVERSAL");
  expect(await applyReversal(reversal.id)).toMatchObject({ status: "RELEASED", hold: { releaseMovementId: reversal.id } });
  expect((await current()).enabled).toBe(false);
  await releaseStaffHold(userId, staff.id, "case-1", "review complete");
  expect((await current()).enabled).toBe(true);
  expect(await prisma.serviceHold.count({ where: { releasedAt: null } })).toBe(0);
  expect(await prisma.auditLog.count({ where: { action: { startsWith: "subscription.hold." } } })).toBe(4);
});

it("rolls allocation and grant back if projection cannot commit and succeeds on a retry", async () => {
  const capture = await fact(await offerOrder());
  await prisma.subscription.create({ data: { userId, revision: 2_147_483_647 } });
  await expect(allocateCapture(capture.id)).rejects.toThrow();
  expect(await prisma.orderAllocation.count()).toBe(0);
  expect(await prisma.periodGrant.count()).toBe(0);
  expect(await prisma.fulfillmentJob.count()).toBe(0);
  await prisma.subscription.update({ where: { userId }, data: { revision: 0 } });
  await booked(capture);
  expect(await prisma.periodGrant.count()).toBe(1);
});

it("preserves a legacy/unverified binding and refuses to infer a grant", async () => {
  await createOrder(userId);
  const capture = await fact(await offerOrder());
  expect(await allocateCapture(capture.id)).toMatchObject({ status: "REVIEW", reason: "LEGACY_ACCESS_UNVERIFIED" });
  expect(await prisma.subscription.findUnique({ where: { userId } })).toMatchObject({ legacyUnverified: true });
  expect(await prisma.periodGrant.count()).toBe(0);
});

async function historicalInterval(startAt: Date, endAt: Date, serial: number, deviceLimit: number) {
  const order = await offerOrder({ createdAt: new Date(startAt.getTime() - 60_000), deviceLimit });
  const capture = await fact(order, account, { providerTime: order.createdAt });
  const grant = await subscriptionTransaction(async db => {
    const subscription = await createSubscription(db, userId);
    const allocation = await db.orderAllocation.create({ data: { orderId: order.id, captureId: capture.id, createdAt: startAt } });
    return db.periodGrant.create({ data: { allocationId: allocation.id, orderId: order.id, createdAt: startAt,
      subscriptionId: subscription.id, serial, deviceLimit, startAt, endAt, calendarVersion: 1 } });
  });
  return { grant, capture };
}

it("replays June R03 exactly and restores the independent July period at its own boundary", async () => {
  const june = new Date("2025-06-01T00:00:00Z");
  const july = new Date("2025-07-01T00:00:00Z");
  const august = new Date("2025-08-01T00:00:00Z");
  const cutoff = new Date("2025-06-20T00:00:00Z");
  const first = await historicalInterval(june, july, 1, 5);
  const second = await historicalInterval(july, august, 2, 9);
  const refund = await reverse(first.capture, "REFUND", first.capture.amountMinor, cutoff);
  await applyReversal(refund.id);
  const projectAt = (time: Date) => subscriptionTransaction(async db =>
    projectAssignment(db, (await lockSubscription(db, userId))!, time, "REHEARSAL"));
  expect(await projectAt(cutoff)).toMatchObject({ enabled: false, nextBoundaryAt: july });
  expect(await projectAt(july)).toMatchObject({ enabled: true, nextBoundaryAt: august, deviceLimit: 9 });
  expect(await prisma.periodGrant.findUnique({ where: { id: second.grant.id } })).toEqual(second.grant);
});

it("recovers missed boundaries deterministically without HTTP and enforces non-overlap in PostgreSQL", async () => {
  const now = await dbNow(prisma);
  const yesterday = new Date(now.getTime() - 86_400_000);
  const earlier = new Date(yesterday.getTime() - 86_400_000);
  const later = new Date(now.getTime() + 86_400_000);
  const first = await historicalInterval(earlier, yesterday, 1, 5);
  const second = await historicalInterval(yesterday, later, 2, 12);
  await expect(historicalInterval(earlier, later, 3, 8)).rejects.toThrow(/exclu|overlap/i);
  await subscriptionTransaction(async db => projectAssignment(db, (await lockSubscription(db, userId))!, earlier, "REHEARSAL"));
  expect(await refreshDueAssignments()).toBe(1);
  expect(await refreshDueAssignments()).toBe(0);
  expect((await current())).toMatchObject({ enabled: true, grantId: second.grant.id, deviceLimit: 12, revision: 2 });
  expect(await prisma.periodGrant.count()).toBe(2);
  expect((await prisma.periodGrant.findUniqueOrThrow({ where: { id: first.grant.id } })).endAt).toEqual(yesterday);
});
