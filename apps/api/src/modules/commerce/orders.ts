import type { OfferVersion, Order } from "@prisma/client";
import type { OrderSnapshot } from "@vpn/shared";
import { env } from "../../config/env";
import { sha256 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { dbNow } from "./offers";

const orderWithVersion = { offerVersion: true } as const;
const CHECKOUT_POLICY_VERSION = 1;

export async function checkout(userId: string, key: string, offerVersionId: string, restriction?: () => string | undefined) {
  const checkoutKeyHash = sha256(key);
  return prisma.$transaction(async db => {
    // The lock is scoped to this checkout key; the unique index is the durable guarantee.
    // ReadCommitted makes a new statement observe the winning transaction after the lock wait.
    await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(
      hashtextextended(${`checkout:${userId}:${checkoutKeyHash}`}, 0)
    )`;
    const existing = await db.order.findUnique({
      where: { userId_checkoutKeyHash: { userId, checkoutKeyHash } },
      include: orderWithVersion,
    });
    if (existing) {
      // The canonical request has one field. Its persisted FK is the exact fingerprint.
      if (existing.offerVersionId !== offerVersionId) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
      return existing;
    }

    const denied = restriction?.();
    if (denied) throw new AppError(503, denied);

    // Lock the same plan row as all staff publication and retirement commands.
    // Concurrent buyers can hold this lock together.
    const [lock] = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM mzt_lock_offer_plan(${offerVersionId})
    `;
    if (!lock) throw new AppError(409, "OFFER_UNAVAILABLE");
    const version = await db.offerVersion.findUniqueOrThrow({
      where: { id: offerVersionId }, include: { offer: { include: { plan: true } } },
    });
    if (!version.offer.isActive || !version.offer.plan.isActive) throw new AppError(409, "OFFER_UNAVAILABLE");
    if (version.withdrawnAt) throw new AppError(409, "OFFER_CHANGED");

    const createdAt = await dbNow(db);
    return db.order.create({
      data: {
        userId, checkoutKeyHash, offerVersionId, planId: lock.id, createdAt,
        checkoutPolicyVersion: CHECKOUT_POLICY_VERSION,
        durationMonths: version.durationMonths, deviceLimit: version.deviceLimit,
        amount: version.amount, currency: version.currency,
        expiresAt: new Date(createdAt.getTime() + env.CHECKOUT_TTL_MINUTES * 60_000),
      },
      include: orderWithVersion,
    });
  }, { isolationLevel: "ReadCommitted" });
}

export function ownerOrder(userId: string, id: string) {
  return prisma.order.findFirst({ where: { userId, id }, include: orderWithVersion });
}

export function snapshot(order: Order & { offerVersion: OfferVersion | null }): OrderSnapshot {
  return {
    offerId: order.offerVersion?.planPriceId ?? null, offerVersionId: order.offerVersionId,
    version: order.offerVersion?.version ?? null, planId: order.planId, name: order.offerVersion?.name ?? null,
    durationMonths: order.durationMonths, price: { amountMinor: order.amount, currency: order.currency },
    deviceLimit: order.deviceLimit, trafficLimitBytes: null, trafficStrategy: null,
    policyVersion: order.checkoutPolicyVersion,
    snapshottedAt: order.createdAt.toISOString(), expiresAt: order.expiresAt.toISOString(),
  };
}
