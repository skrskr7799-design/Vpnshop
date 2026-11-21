import type { Subscription } from "@prisma/client";
import { AppError } from "../../lib/errors";
import { dbNow } from "../commerce/offers";
import { auditDecision, createSubscription, lockSubscription, projectAssignment, subscriptionTransaction, type Db } from "./store";

type HoldInput = {
  source: string;
  kind: "CHARGEBACK" | "FRAUD" | "ADMIN" | "SERVICE_CONFLICT";
  reason: string;
  actorId?: string;
  movementId?: string;
};

export async function storeHold(db: Db, subscription: Subscription, now: Date, input: HoldInput) {
  const existing = await db.serviceHold.findUnique({
    where: { subscriptionId_source: { subscriptionId: subscription.id, source: input.source } },
  });
  if (existing) {
    if (existing.kind !== input.kind || existing.reason !== input.reason ||
        existing.movementId !== (input.movementId ?? null) || existing.createdBy !== (input.actorId ?? null)) {
      throw new AppError(409, "HOLD_SOURCE_CONFLICT");
    }
    return existing;
  }
  const hold = await db.serviceHold.create({ data: {
    subscriptionId: subscription.id, source: input.source, kind: input.kind, reason: input.reason,
    createdBy: input.actorId, movementId: input.movementId, createdAt: now,
  } });
  await projectAssignment(db, subscription, now, "SERVICE_HOLD_ADDED");
  await auditDecision(db, subscription.id, "subscription.hold.add", {
    holdId: hold.id, source: input.source, reason: input.reason,
  }, input.actorId);
  return hold;
}

export async function releaseStoredHold(db: Db, subscription: Subscription, now: Date, source: string,
  proof: { actorId: string; reason: string } | { movementId: string }) {
  const hold = await db.serviceHold.findUnique({
    where: { subscriptionId_source: { subscriptionId: subscription.id, source } },
  });
  if (!hold) throw new AppError(404, "HOLD_NOT_FOUND");
  if (hold.releasedAt) return hold;
  if ((hold.kind === "CHARGEBACK") !== ("movementId" in proof)) throw new AppError(409, "HOLD_PROOF_REQUIRED");
  const released = await db.serviceHold.update({ where: { id: hold.id }, data: {
    releasedAt: now, releasedBy: "actorId" in proof ? proof.actorId : null,
    releaseMovementId: "movementId" in proof ? proof.movementId : null,
  } });
  await projectAssignment(db, subscription, now, "SERVICE_HOLD_RELEASED");
  await auditDecision(db, subscription.id, "subscription.hold.release", {
    holdId: hold.id, source, ...proof,
  }, "actorId" in proof ? proof.actorId : null);
  return released;
}

async function authorizeStaff(db: Db, actorId: string, reason: string) {
  if (reason.trim().length === 0 || reason.length > 500) throw new AppError(400, "HOLD_REASON_REQUIRED");
  const actor = await db.user.findUnique({ where: { id: actorId }, select: { role: true, status: true } });
  if (actor?.role !== "ADMIN" || actor.status !== "ACTIVE") throw new AppError(403, "FORBIDDEN");
}

// Internal use by a future staff command after its session and step-up are verified.
export async function placeStaffHold(userId: string, actorId: string, source: string,
  kind: Exclude<HoldInput["kind"], "CHARGEBACK">, reason: string) {
  return subscriptionTransaction(async db => {
    await authorizeStaff(db, actorId, reason);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(source)) throw new AppError(400, "INVALID_HOLD_SOURCE");
    const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND");
    const subscription = await createSubscription(db, userId);
    return storeHold(db, subscription, await dbNow(db), { source: `staff:${source}`, kind, reason, actorId });
  });
}

export async function releaseStaffHold(userId: string, actorId: string, source: string, reason: string) {
  return subscriptionTransaction(async db => {
    await authorizeStaff(db, actorId, reason);
    const subscription = await lockSubscription(db, userId);
    if (!subscription) throw new AppError(404, "SUBSCRIPTION_NOT_FOUND");
    return releaseStoredHold(db, subscription, await dbNow(db), `staff:${source}`, { actorId, reason });
  });
}
