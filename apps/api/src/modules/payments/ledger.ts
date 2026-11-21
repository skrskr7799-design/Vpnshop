import type { MerchantAccount, Order, Payment, PaymentEvidence, PaymentTransaction } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { dbNow } from "../commerce/offers";
import { observationSchema, type Observation, type PaymentMovement } from "./provider";
import { type Db, lockEntitlementAccount, lockOrder, lockPaymentKey, nextCheck, noteCase } from "./store";

async function matchPayment(db: Db, accountId: string, observation: Observation) {
  if (!observation.merchantReference) return null;
  const payment = await db.payment.findUnique({
    where: { accountId_merchantReference: { accountId, merchantReference: observation.merchantReference } },
  });
  if (!payment) return null;
  const order = await lockOrder(db, payment.orderId);
  const current = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
  const byId = await db.payment.findUnique({
    where: { accountId_externalId: { accountId, externalId: observation.externalPaymentId } },
  });
  const consistentId = (!byId || byId.id === current.id) &&
    (!current.externalId || current.externalId === observation.externalPaymentId);
  return order && consistentId && current.provider === "PLATEGA" && order.amount === current.amount &&
    order.currency === current.currency ? { order, payment: current } : null;
}

function sameMovement(row: PaymentTransaction, observation: Observation, movement: PaymentMovement) {
  return row.kind === movement.kind && row.amountMinor === BigInt(movement.amountMinor) && row.currency === movement.currency &&
    row.externalPaymentId === observation.externalPaymentId && row.merchantReference === observation.merchantReference &&
    row.originalMovementKey === movement.originalMovementKey &&
    (row.providerTime?.getTime() ?? null) === (movement.providerTime ? Date.parse(movement.providerTime) : null);
}

async function reviewCapture(
  db: Db, account: MerchantAccount, order: Order, payment: Payment, observed: PaymentTransaction, now: Date,
) {
  const key = `order:${order.id}`;
  const review = (kind: string) => noteCase(db, account, kind, key, kind, { movementKey: observed.movementKey }, now);
  if (observed.amountMinor !== BigInt(payment.amount)) await review("AMOUNT_MISMATCH");
  if (observed.currency !== payment.currency) await review("CURRENCY_MISMATCH");
  if (!observed.providerTime || observed.providerTime >= order.expiresAt) await review("LATE_OR_UNTIMED_CAPTURE");
  if (order.status !== "PENDING") await review("ORDER_STATE_REVIEW");

  const extra = await db.paymentTransaction.findFirst({
    where: { accountId: account.id, kind: "CAPTURE", movementKey: { not: observed.movementKey },
      OR: [{ payment: { orderId: order.id } }, { merchantReference: payment.merchantReference }] },
  });
  if (extra) await review("MULTIPLE_CAPTURES");

  const reversal = await db.paymentTransaction.findFirst({
    where: { accountId: account.id, originalMovementKey: observed.movementKey },
  });
  if (reversal) await review("REVERSAL_PRESENT");
}

async function noteNonterminal(
  db: Db, account: MerchantAccount, payment: Payment, observation: Observation, now: Date,
) {
  if (observation.status === "UNKNOWN" || observation.status === "CONFIRMED") {
    await noteCase(db, account, "UNKNOWN_PROVIDER_STATUS", `attempt:${payment.id}`,
      "UNKNOWN_PROVIDER_STATUS", {}, now);
    return;
  }
  if (payment.status === "SUCCEEDED") {
    // Pending webhook can legitimately be delivered after capture. An authenticated
    // current lookup claiming the payment failed is handled separately by the caller.
    return;
  }
  if (["FAILED", "EXPIRED", "CANCELED"].includes(payment.status)) return;
  if (observation.status === "AWAITING_CUSTOMER" && payment.status === "PROCESSING") return;
  await db.payment.update({ where: { id: payment.id }, data: {
    externalId: observation.externalPaymentId, status: observation.status,
    reasonCode: observation.status === "FAILED" ? "PROVIDER_REJECTED" : null,
    nextCheckAt: observation.status === "FAILED" ? null : nextCheck(now),
  } });
}

// Both persisted callback processing and authenticated pull enter here.
export async function recordObservation(
  db: Db, account: MerchantAccount, value: Observation, evidence: PaymentEvidence, receivedAt?: Date,
) {
  const observation = observationSchema.parse(value);
  await lockEntitlementAccount(db, account.id);
  await lockPaymentKey(db, "invoice", account.id, observation.externalPaymentId);
  const now = await dbNow(db);
  const match = await matchPayment(db, account.id, observation);
  const observedKey = `invoice:${observation.externalPaymentId}`;
  if (!match) await noteCase(db, account, "PAYMENT_IDENTITY_MISMATCH", observedKey,
    "PAYMENT_IDENTITY_MISMATCH", { reference: observation.merchantReference }, now);

  const movement = observation.movement;
  if (!movement) {
    if (match && evidence === "LOOKUP" && match.payment.status === "SUCCEEDED") {
      await noteCase(db, account, "LOOKUP_CONTRADICTION", `order:${match.order.id}`,
        "LOOKUP_CONTRADICTION", { observedStatus: observation.status }, now);
    } else if (match) await noteNonterminal(db, account, match.payment, observation, now);
    return;
  }

  const identity = { accountId: account.id, movementKey: movement.key };
  await db.paymentTransaction.createMany({
    data: [{
      ...identity, kind: movement.kind, receivedAt: receivedAt ?? now, evidence,
      amountMinor: BigInt(movement.amountMinor), currency: movement.currency,
      providerTime: movement.providerTime ? new Date(movement.providerTime) : null,
      originalMovementKey: movement.originalMovementKey,
      externalPaymentId: observation.externalPaymentId, merchantReference: observation.merchantReference,
      paymentId: match?.payment.id,
    }],
    skipDuplicates: true,
  });
  const fact = await db.paymentTransaction.findUniqueOrThrow({ where: { accountId_movementKey: identity } });
  if (!sameMovement(fact, observation, movement)) {
    await noteCase(db, account, "MOVEMENT_CONFLICT", `movement:${movement.key}`,
      "MOVEMENT_CONFLICT", { observation, evidence }, now);
    return;
  }
  if (movement.kind === "CAPTURE" && match) {
    await reviewCapture(db, account, match.order, match.payment, fact, now);
    if (match.payment.status !== "SUCCEEDED" &&
        fact.amountMinor === BigInt(match.payment.amount) && fact.currency === match.payment.currency) {
      await db.payment.update({ where: { id: match.payment.id }, data: {
        externalId: fact.externalPaymentId, status: "SUCCEEDED", paidAt: fact.providerTime,
        reasonCode: null, nextCheckAt: null,
      } });
    }
  }
  if (movement.originalMovementKey) {
    const original = await db.paymentTransaction.findUnique({
      where: { accountId_movementKey: { accountId: account.id, movementKey: movement.originalMovementKey } },
    });
    const expectedKind = movement.kind === "CHARGEBACK_REVERSAL" ? "CHARGEBACK_DEBIT" : "CAPTURE";
    const related = original?.kind === expectedKind && original.externalPaymentId === fact.externalPaymentId &&
      original.currency === fact.currency && original.merchantReference === fact.merchantReference;
    await noteCase(db, account, related ? "REVERSAL_PRESENT" : "UNRESOLVED_REVERSAL", `movement:${movement.key}`,
      related ? "REVIEW_REVERSED_FUNDS" : "ORIGINAL_CAPTURE_NOT_CONFIRMED", {
        originalMovementKey: movement.originalMovementKey,
      }, now);
  }
}

export function recordLookup(account: MerchantAccount, observation: Observation) {
  return prisma.$transaction(db => recordObservation(db, account, observation, "LOOKUP"),
    { isolationLevel: "ReadCommitted" });
}
