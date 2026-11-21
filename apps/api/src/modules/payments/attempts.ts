import { randomUUID } from "node:crypto";
import type { MerchantAccount, Payment } from "@prisma/client";
import { paymentAttemptSchema, type PaymentChannel } from "@vpn/shared";
import { AppError } from "../../lib/errors";
import { sha256 } from "../../lib/crypto";
import { prisma } from "../../lib/prisma";
import { dbNow } from "../commerce/offers";
import { DefinitiveCreateRejection, safeInvoice, type PaymentProviderAdapter } from "./provider";
import { lockOrder, lockPaymentKey, nextCheck, noteCase } from "./store";

export async function createAttempt(
  account: MerchantAccount, adapter: PaymentProviderAdapter,
  userId: string, orderId: string, channel: PaymentChannel, key: string,
) {
  const reservation = await prisma.$transaction(async db => {
    const order = await lockOrder(db, orderId);
    if (!order || order.userId !== userId) throw new AppError(404, "NOT_FOUND");
    const requestKeyHash = sha256(key);
    const existing = await db.payment.findUnique({ where: { orderId_requestKeyHash: { orderId, requestKeyHash } } });
    if (existing) {
      if (existing.channel !== channel || existing.accountId !== account.id) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
      return { attempt: existing, submit: false };
    }
    const now = await dbNow(db);
    if (order.status !== "PENDING" || order.expiresAt <= now) throw new AppError(409, "ORDER_CLOSED");
    if (order.currency !== "RUB" || !order.offerVersionId || !adapter.channels.includes(channel)) {
      throw new AppError(409, "CHANNEL_UNAVAILABLE");
    }
    const blocking = await db.payment.findFirst({
      where: { orderId, OR: [
        { status: { notIn: ["FAILED", "EXPIRED", "CANCELED"] } }, { externalId: { not: null } },
      ] },
      select: { id: true },
    });
    if (blocking) throw new AppError(409, "ATTEMPT_IN_PROGRESS");
    const attempt = await db.payment.create({ data: {
      orderId, accountId: account.id, provider: account.provider, status: "CREATED",
      merchantReference: randomUUID(), requestKeyHash, channel, amount: order.amount, currency: order.currency,
      expiresAt: order.expiresAt, nextCheckAt: nextCheck(now),
    } });
    const submitting = await db.payment.update({ where: { id: attempt.id }, data: { status: "SUBMITTING" } });
    return { attempt: submitting, submit: true };
  }, { isolationLevel: "ReadCommitted" });

  const attempt = reservation.attempt;
  if (!reservation.submit) return attempt;

  let invoice: ReturnType<typeof safeInvoice> | undefined;
  let reasonCode: string | undefined;
  try {
    invoice = safeInvoice(adapter, await adapter.createPayment({
      merchantReference: attempt.merchantReference!, amountMinor: attempt.amount, currency: "RUB",
      channel, expiresAt: attempt.expiresAt!,
    }));
  } catch (error) {
    reasonCode = error instanceof DefinitiveCreateRejection ? "PROVIDER_REJECTED" : "CREATE_OUTCOME_UNKNOWN";
  }

  return prisma.$transaction(async db => {
    if (invoice) await lockPaymentKey(db, "invoice", account.id, invoice.externalId);
    await lockOrder(db, orderId);
    const current = await db.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    const now = await dbNow(db);
    if (invoice) {
      const other = await db.payment.findUnique({
        where: { accountId_externalId: { accountId: account.id, externalId: invoice.externalId } },
      });
      if ((other && other.id !== current.id) || (current.externalId && current.externalId !== invoice.externalId)) {
        invoice = undefined;
        reasonCode = "EXTERNAL_ID_CONFLICT";
      }
    }
    if (reasonCode && reasonCode !== "PROVIDER_REJECTED") {
      await noteCase(db, account, reasonCode, `attempt:${current.id}`, reasonCode, {}, now);
    }
    // Evidence already applied by reconciliation or a callback takes precedence over create.
    if (current.status !== "SUBMITTING" && current.status !== "UNKNOWN") return current;
    if (invoice) return db.payment.update({ where: { id: current.id }, data: {
      ...invoice, status: "AWAITING_CUSTOMER", reasonCode: null, nextCheckAt: nextCheck(now),
    } });
    if (current.status !== "SUBMITTING") return current;
    const rejected = reasonCode === "PROVIDER_REJECTED";
    return db.payment.update({ where: { id: current.id }, data: {
      status: rejected ? "FAILED" : "UNKNOWN", reasonCode, nextCheckAt: rejected ? null : nextCheck(now),
    } });
  });
}

export function paymentDto(payment: Payment) {
  return paymentAttemptSchema.parse({
    id: payment.id, channel: payment.channel, status: payment.status,
    createdAt: payment.createdAt.toISOString(), updatedAt: payment.updatedAt.toISOString(),
    expiresAt: payment.expiresAt?.toISOString(), reasonCode: payment.reasonCode,
  });
}

export async function attemptResult(payment: Payment, allowRedirect: boolean) {
  const attempt = paymentDto(payment);
  const nextAction = allowRedirect && attempt.status === "AWAITING_CUSTOMER" && payment.redirectUrl &&
    payment.expiresAt! > await dbNow(prisma)
    ? { type: "REDIRECT" as const, url: payment.redirectUrl, expiresAt: attempt.expiresAt }
    : { type: "WAIT" as const };
  return { attempt, nextAction };
}
