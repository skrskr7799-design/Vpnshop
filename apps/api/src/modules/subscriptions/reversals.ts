import type { MerchantAccount, PaymentTransaction, PeriodGrant, Subscription } from "@prisma/client";
import { dbNow } from "../commerce/offers";
import { lockEntitlementAccount, lockOrder, noteCase } from "../payments/store";
import { canUseAccount } from "./allocation";
import { releaseStoredHold, storeHold } from "./holds";
import { auditDecision, lockSubscription, projectAssignment, subscriptionTransaction, type Db } from "./store";

const sameIdentity = (movement: PaymentTransaction, capture: PaymentTransaction) =>
  movement.accountId === capture.accountId && movement.currency === capture.currency &&
  movement.externalPaymentId === capture.externalPaymentId && !!capture.merchantReference &&
  movement.merchantReference === capture.merchantReference && movement.paymentId === capture.paymentId;

function verifiedTiming(movement: PaymentTransaction, capture: PaymentTransaction, now: Date) {
  return !!movement.providerTime && !!capture.providerTime &&
    movement.providerTime >= capture.providerTime && movement.providerTime <= now;
}

type RecordWithAccount = PaymentTransaction & { account: MerchantAccount };
async function review(db: Db, movement: RecordWithAccount, reason: string, now: Date) {
  await noteCase(db, movement.account, reason, `movement:${movement.movementKey}`, reason, {}, now);
  return { status: "REVIEW" as const, reason };
}

async function applyRefund(
  db: Db, movement: RecordWithAccount, capture: PaymentTransaction, grant: PeriodGrant,
  subscription: Subscription, now: Date,
) {
  const adjustment = await db.adjustment.findUnique({ where: { grantId: grant.id } });
  const related = await db.paymentTransaction.findMany({
    where: { accountId: capture.accountId, kind: "REFUND", originalMovementKey: capture.movementKey },
    orderBy: [{ providerTime: "asc" }, { movementKey: "asc" }],
  });
  const trusted = related.filter(refund => sameIdentity(refund, capture) && verifiedTiming(refund, capture, now));
  const total = trusted.reduce((sum, refund) => sum + refund.amountMinor, 0n);
  if (trusted.length !== related.length || total > capture.amountMinor) {
    return review(db, movement, "REFUND_TOTAL_REVIEW", now);
  }
  if (adjustment) return { status: "ADJUSTED" as const, adjustment };
  if (total < capture.amountMinor) return review(db, movement, "PARTIAL_REFUND_POLICY_REVIEW", now);
  const finalRefund = trusted.at(-1)!;
  const cutoff = Math.min(grant.endAt.getTime(), Math.max(grant.startAt.getTime(), finalRefund.providerTime!.getTime()));
  const saved = await db.adjustment.create({ data: {
    grantId: grant.id, movementId: finalRefund.id, effectiveAt: new Date(cutoff), createdAt: now, reason: "FULL_REFUND",
  } });
  await projectAssignment(db, subscription, now, "FULL_REFUND");
  await auditDecision(db, subscription.id, "subscription.adjust", {
    grantId: grant.id, movementId: finalRefund.id, adjustmentId: saved.id, effectiveAt: saved.effectiveAt.toISOString(),
  });
  return { status: "ADJUSTED" as const, adjustment: saved };
}

async function byMovementKey(db: Db, movement: PaymentTransaction, movementKey: string | null) {
  if (!movementKey) return null;
  return db.paymentTransaction.findUnique({
    where: { accountId_movementKey: { accountId: movement.accountId, movementKey } },
  });
}

// Used by trusted internal callers only. Finance locks account -> order before subscription.
export async function applyReversal(movementId: string) {
  return subscriptionTransaction(async db => {
    const movement = await db.paymentTransaction.findUnique({
      where: { id: movementId }, include: { account: true },
    });
    if (!movement || !canUseAccount(movement.account) ||
        !["REFUND", "CHARGEBACK_DEBIT", "CHARGEBACK_REVERSAL"].includes(movement.kind)) {
      return { status: "REVIEW" as const, reason: "UNVERIFIED_REVERSAL" };
    }
    await lockEntitlementAccount(db, movement.accountId);
    const original = await byMovementKey(db, movement, movement.originalMovementKey);
    const debit = movement.kind === "CHARGEBACK_REVERSAL" ? original : null;
    const capture = debit ? await byMovementKey(db, debit, debit.originalMovementKey) : original;
    const now = await dbNow(db);
    if (capture?.kind !== "CAPTURE" || !sameIdentity(movement, capture) || !verifiedTiming(movement, capture, now) ||
        (debit && (debit.kind !== "CHARGEBACK_DEBIT" || !sameIdentity(debit, capture) ||
          !verifiedTiming(debit, capture, now) || debit.providerTime! > movement.providerTime!))) {
      return review(db, movement, "REVERSAL_IDENTITY_REVIEW", now);
    }
    const conflict = await db.paymentCase.findFirst({
      where: { accountId: movement.accountId, status: { not: "RESOLVED" }, OR: [
        { kind: "MOVEMENT_CONFLICT", objectKey: { in: [`movement:${movement.movementKey}`, `movement:${capture.movementKey}`,
          ...(debit ? [`movement:${debit.movementKey}`] : [])] } },
        { kind: "EVENT_CONFLICT", details: { path: ["observation", "externalPaymentId"], equals: movement.externalPaymentId } },
      ] },
      select: { id: true },
    });
    if (conflict) return review(db, movement, "REVERSAL_CONFLICT_REVIEW", now);
    const allocation = await db.orderAllocation.findUnique({
      where: { captureId: capture.id }, include: { grant: true },
    });
    if (!allocation?.grant) {
      // Do not affect independent periods for an unallocated or duplicate payment.
      return review(db, movement, "UNALLOCATED_REVERSAL", now);
    }
    const order = (await lockOrder(db, allocation.orderId))!;
    const subscription = (await lockSubscription(db, order.userId))!;
    const effectiveNow = await dbNow(db);
    if (movement.kind === "REFUND") return applyRefund(db, movement, capture, allocation.grant, subscription, effectiveNow);
    if (movement.kind === "CHARGEBACK_DEBIT") {
      const hold = await storeHold(db, subscription, effectiveNow, {
        kind: "CHARGEBACK", source: `chargeback:${movement.id}`, movementId: movement.id, reason: "CONFIRMED_CHARGEBACK",
      });
      return { status: "HELD" as const, hold };
    }
    if (!debit || movement.amountMinor !== debit.amountMinor ||
        !await db.serviceHold.findUnique({ where: { movementId: debit.id }, select: { id: true } })) {
      return review(db, movement, "CHARGEBACK_RELEASE_REVIEW", now);
    }
    const hold = await releaseStoredHold(db, subscription, effectiveNow, `chargeback:${debit.id}`, { movementId: movement.id });
    if (hold.releaseMovementId !== movement.id) return review(db, movement, "CHARGEBACK_RELEASE_REVIEW", now);
    return { status: "RELEASED" as const, hold };
  });
}
