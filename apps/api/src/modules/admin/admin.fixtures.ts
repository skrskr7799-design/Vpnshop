import { randomUUID } from "node:crypto";
import type { MovementKind } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { publishOffer, dbNow } from "../commerce/offers";
import { checkout } from "../commerce/orders";
import { recordLookup } from "../payments/ledger";
import { allocateCapture } from "../subscriptions/allocation";

export function financeFact(accountId: string, kind: MovementKind, amountMinor: bigint, currency: string, originalMovementKey?: string,
  paymentId?: string, externalPaymentId = randomUUID()) {
  return prisma.paymentTransaction.create({ data: {
    accountId, kind, amountMinor, currency, originalMovementKey, movementKey: randomUUID(),
    paymentId, externalPaymentId, providerTime: new Date(), evidence: "LOOKUP",
  } });
}
export async function paidOrder(userId: string) {
  const account = await prisma.merchantAccount.create({ data: { provider: "PLATEGA", environment: "MOCK", merchant: randomUUID() } });
  const plan = await prisma.plan.create({ data: { code: randomUUID(), name: "Fixture", deviceLimit: 3 } });
  const price = await prisma.planPrice.create({ data: { planId: plan.id, durationMonths: 1, currency: "RUB", amount: 10000 } });
  const offer = await publishOffer(prisma, plan, price, await dbNow(prisma));
  const order = await checkout(userId, randomUUID(), offer.id);
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: "PLATEGA", accountId: account.id,
    merchantReference: randomUUID(), externalId: randomUUID(), channel: "SBP", currency: "RUB", amount: 10000, status: "PROCESSING",
  } });
  const key = randomUUID();
  await recordLookup(account, { status: "CONFIRMED", externalPaymentId: payment.externalId!, merchantReference: payment.merchantReference,
    movement: { key, kind: "CAPTURE", amountMinor: "10000", currency: "RUB", providerTime: (await dbNow(prisma)).toISOString(), originalMovementKey: null },
  });
  const capture = await prisma.paymentTransaction.findUniqueOrThrow({ where: { accountId_movementKey: { accountId: account.id, movementKey: key } } });
  const allocation = await allocateCapture(capture.id);
  if (allocation.status !== "ALLOCATED") throw new Error("Synthetic capture was not allocated: " + allocation.reason);
  return { order, capture, payment, grant: allocation.grant };
}
