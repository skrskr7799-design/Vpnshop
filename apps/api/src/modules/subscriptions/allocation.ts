import type { MerchantAccount, Payment, PaymentTransaction } from "@prisma/client";
import { dbNow } from "../commerce/offers";
import { lockOrder, lockEntitlementAccount, noteCase } from "../payments/store";
import { computeTargetExpireAt } from "../remnawave/remnawave.dates";
import { auditDecision, createSubscription, projectAssignment, subscriptionTransaction, type Db } from "./store";

export const CALENDAR_VERSION = 1;

// Admission is limited to the isolated fixture until a real merchant is verified.
export function canUseAccount(account: MerchantAccount) {
  return account.provider === "PLATEGA" && account.environment === "MOCK" && process.env.NODE_ENV === "test";
}

export async function hasPendingEvidence(db: Db, fact: PaymentTransaction, orderId?: string) {
  const [row] = await db.$queryRaw<{ pending: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "WebhookEvent" WHERE "accountId" = ${fact.accountId} AND "processedAt" IS NULL
        AND (payload->>'externalPaymentId' = ${fact.externalPaymentId}
          OR payload->>'merchantReference' = ${fact.merchantReference}::text
          OR payload#>>'{movement,originalMovementKey}' = ${fact.movementKey}
          OR payload->>'externalPaymentId' IS NULL
          OR EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = ${orderId ?? null}::text
            AND p."accountId" = ${fact.accountId} AND (p."merchantReference" = payload->>'merchantReference'
              OR p."externalId" = payload->>'externalPaymentId')))
    ) AS pending`;
  return row?.pending ?? true;
}

async function hasBlockingCases(db: Db, fact: PaymentTransaction, payment: Payment) {
  const [row] = await db.$queryRaw<{ blocked: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "PaymentCase"
      WHERE "accountId" = ${fact.accountId} AND status <> 'RESOLVED'
        AND kind <> 'CAPTURE_DISCOVERED_BY_LOOKUP'
        AND ("objectKey" IN (${`order:${payment.orderId}`}, ${`attempt:${payment.id}`},
          ${`invoice:${fact.externalPaymentId}`}, ${`movement:${fact.movementKey}`})
          OR details#>>'{observation,externalPaymentId}' = ${fact.externalPaymentId}
          OR details#>>'{observation,merchantReference}' = ${fact.merchantReference}::text
          OR details#>>'{observation,movement,originalMovementKey}' = ${fact.movementKey})
    ) AS blocked`;
  return row?.blocked ?? true;
}

export async function allocateCapture(captureId: string) {
  return subscriptionTransaction(async db => {
    const fact = await db.paymentTransaction.findUnique({
      where: { id: captureId }, include: { account: true },
    });
    if (!fact || fact.kind !== "CAPTURE" || !fact.paymentId || !canUseAccount(fact.account)) {
      return { status: "REVIEW" as const, reason: "UNVERIFIED_CAPTURE" };
    }
    await lockEntitlementAccount(db, fact.accountId);
    const initialPayment = await db.payment.findUniqueOrThrow({ where: { id: fact.paymentId } });
    const order = (await lockOrder(db, initialPayment.orderId))!;
    const existing = await db.orderAllocation.findUnique({ where: { orderId: order.id }, include: { grant: true } });
    if (existing?.captureId === captureId && existing.grant) return { status: "ALLOCATED" as const, grant: existing.grant };
    const now = await dbNow(db);
    const review = async (reason: string) => {
      await noteCase(db, fact.account, reason, `movement:${fact.movementKey}`, reason, { orderId: order.id }, now);
      return { status: "REVIEW" as const, reason };
    };
    if (existing) return review("CAPTURE_NOT_ALLOCATED");
    const payment = await db.payment.findUniqueOrThrow({ where: { id: fact.paymentId } });
    if (order.status !== "PENDING" || !order.offerVersionId) return review("ORDER_STATE_REVIEW");
    if (!fact.providerTime || fact.providerTime < order.createdAt || fact.providerTime >= order.expiresAt ||
        fact.providerTime > now) return review("CAPTURE_OUTSIDE_ORDER_WINDOW");
    if (payment.accountId !== fact.accountId || payment.provider !== fact.account.provider ||
        payment.externalId !== fact.externalPaymentId || payment.merchantReference !== fact.merchantReference ||
        payment.status !== "SUCCEEDED" || !fact.merchantReference || order.currency !== "RUB" ||
        fact.currency !== order.currency || payment.currency !== order.currency ||
        fact.amountMinor !== BigInt(order.amount) || payment.amount !== order.amount) {
      return review("CAPTURE_PROOF_MISMATCH");
    }
    // Before acknowledging ingress or recording a pull, Payments takes the same account lock.
    if (await hasPendingEvidence(db, fact, order.id)) return { status: "REVIEW" as const, reason: "INBOX_PENDING" };
    const reversal = await db.paymentTransaction.findFirst({
      where: { accountId: fact.accountId, kind: { in: ["REFUND", "CHARGEBACK_DEBIT", "CHARGEBACK_REVERSAL"] },
        OR: [{ originalMovementKey: fact.movementKey }, { externalPaymentId: fact.externalPaymentId },
          { merchantReference: fact.merchantReference }] },
      select: { id: true },
    });
    if (reversal) return review("CAPTURE_REVERSED");
    if (await hasBlockingCases(db, fact, payment)) return { status: "REVIEW" as const, reason: "FINANCIAL_REVIEW" };

    const subscription = await createSubscription(db, order.userId);
    if (subscription.legacyUnverified) return review("LEGACY_ACCESS_UNVERIFIED");
    const tail = await db.periodGrant.findFirst({
      where: { subscriptionId: subscription.id }, orderBy: { serial: "desc" },
    });
    // Clock is read after acquiring the subscription lock, including after lock contention.
    const grantedAt = await dbNow(db);
    const startAt = tail && tail.endAt > grantedAt ? tail.endAt : grantedAt;
    const allocation = await db.orderAllocation.create({ data: { orderId: order.id, captureId, createdAt: grantedAt } });
    const grant = await db.periodGrant.create({ data: {
      orderId: order.id, allocationId: allocation.id, subscriptionId: subscription.id,
      serial: (tail?.serial ?? 0) + 1, startAt, endAt: computeTargetExpireAt(tail?.endAt ?? null, order.durationMonths, grantedAt),
      calendarVersion: CALENDAR_VERSION, deviceLimit: order.deviceLimit, createdAt: grantedAt,
    } });
    await projectAssignment(db, subscription, grantedAt, "CAPTURE_ALLOCATED", true);
    await auditDecision(db, subscription.id, "subscription.allocate", {
      captureId, orderId: order.id, allocationId: allocation.id, grantId: grant.id,
    });
    return { status: "ALLOCATED" as const, grant };
  });
}
