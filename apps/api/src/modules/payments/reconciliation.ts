import type { MerchantAccount } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { dbNow } from "../commerce/offers";
import { processInbox } from "./inbox";
import { recordLookup } from "./ledger";
import type { Observation, PaymentProviderAdapter } from "./provider";
import { nextCheck, noteCase } from "./store";

const MAX_LOOKUP_AGE_MS = 48 * 60 * 60 * 1000;

export async function reconcileAttempts(account: MerchantAccount, adapter: PaymentProviderAdapter, limit = 20) {
  const now = await dbNow(prisma);
  const due = await prisma.payment.findMany({
    where: { accountId: account.id, nextCheckAt: { lte: now } },
    orderBy: [{ nextCheckAt: "asc" }, { id: "asc" }], take: limit,
  });
  for (const payment of due) {
    const exhausted = now.getTime() - payment.createdAt.getTime() >= MAX_LOOKUP_AGE_MS;
    const reserved = await prisma.payment.updateMany({
      where: { id: payment.id, nextCheckAt: payment.nextCheckAt, status: payment.status },
      data: {
        nextCheckAt: exhausted ? null : nextCheck(now),
        ...(payment.status === "SUBMITTING" && { status: "UNKNOWN", reasonCode: "CREATE_OUTCOME_UNKNOWN" }),
      },
    });
    if (!reserved.count) continue;

    let observation: Observation | null | undefined;
    let reason: string | undefined;
    if (exhausted) reason = "LOOKUP_DEADLINE";
    else {
      try {
        observation = payment.externalId
          ? await adapter.getPaymentStatus(payment.externalId)
          : await adapter.findByMerchantReference?.(payment.merchantReference!);
        if (!observation) reason = payment.externalId ? "UNKNOWN_EXTERNAL_PAYMENT" : "CREATE_OUTCOME_UNKNOWN";
        if (observation && (observation.merchantReference !== payment.merchantReference ||
            (payment.externalId && payment.externalId !== observation.externalPaymentId))) {
          reason = "LOOKUP_IDENTITY_MISMATCH";
          observation = null;
        }
      } catch {
        reason = "LOOKUP_UNAVAILABLE";
      }
    }
    if (observation) {
      await recordLookup(account, observation);
      const movement = observation.movement;
      if (movement && movement.kind === "CAPTURE") {
        const fact = await prisma.paymentTransaction.findUnique({
          where: { accountId_movementKey: { accountId: account.id, movementKey: movement.key } },
        });
        if (fact?.evidence === "LOOKUP") reason = "CAPTURE_DISCOVERED_BY_LOOKUP";
      }
    }
    if (reason) await noteCase(prisma, account, reason, `attempt:${payment.id}`, reason, {}, now);
  }
  return due.length;
}

// Bounded pass for an independently scheduled processor. Retries of create are never scheduled.
export async function runPaymentMaintenance(account: MerchantAccount, adapter: PaymentProviderAdapter) {
  const inbox = await processInbox(account);
  const lookups = await reconcileAttempts(account, adapter);
  return { inbox, lookups };
}
