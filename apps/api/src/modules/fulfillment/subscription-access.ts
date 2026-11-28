import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { dbNow } from "../commerce/offers";
import { matchesProfile, type AssignmentPanel } from "../remnawave/remnawave.assignment";
import { absoluteProfile } from "./revision.processor";
import { bindingIdentityMatches, driftIntervalMs } from "./revision.queue";

import { subscriptionLinkAllowed } from "./subscription-link-policy";

async function accessTarget(userId: string, panel: AssignmentPanel, forLink = true) {
  return prisma.$transaction(async db => {
    if (forLink && !await subscriptionLinkAllowed(db, userId)) throw new AppError(403, "SUBSCRIPTION_LINK_DISABLED");
    const now = await dbNow(db);
    const subscription = await db.subscription.findUnique({ where: { userId }, include: {
      panelBinding: true, holds: { where: { releasedAt: null }, select: { id: true }, take: 1 },
    } });
    if (!subscription) throw new AppError(409, "ACCESS_NOT_READY");
    if (subscription.legacyUnverified || subscription.holds.length || subscription.panelBinding?.blockedReason) {
      throw new AppError(409, "ACCESS_HELD");
    }
    const desired = await db.desiredAssignment.findUnique({
      where: { subscriptionId_revision: { subscriptionId: subscription.id, revision: subscription.revision } },
      include: { job: true, grant: { include: { adjustment: true } } },
    });
    if (desired && (!desired.enabled || !desired.expiresAt || desired.expiresAt <= now ||
        !desired.grant || desired.grant.startAt > now ||
        (desired.grant.adjustment?.effectiveAt ?? desired.grant.endAt) <= now)) {
      throw new AppError(409, "ACCESS_EXPIRED");
    }
    const binding = subscription.panelBinding;
    if (!desired || !binding || !binding.remoteUserId || binding.panelInstance !== panel.instance ||
        binding.origin !== panel.origin || binding.confirmedRevision !== desired.revision ||
        desired.job?.status !== "CONFIRMED" || !binding.confirmedAt ||
        now.getTime() - binding.confirmedAt.getTime() > 2 * driftIntervalMs) {
      throw new AppError(409, "ACCESS_NOT_READY");
    }
    return { desired, binding };
  }, { isolationLevel: "RepeatableRead" });
}

export async function subscriptionLink(userId: string, panel?: AssignmentPanel) {
  if (!panel) throw new AppError(503, "PANEL_UNAVAILABLE");
  const before = await accessTarget(userId, panel);
  const result = await panel.getSubscriptionLink(Number(before.binding.remoteUserId)).catch(() => {
    throw new AppError(503, "PANEL_UNAVAILABLE");
  });
  const after = await accessTarget(userId, panel);
  if (!result || before.desired.id !== after.desired.id || !bindingIdentityMatches(after.binding, result.user) ||
      result.user.status !== "ACTIVE" || !matchesProfile(result.user, absoluteProfile(after.desired))) {
    throw new AppError(409, "ACCESS_NOT_READY");
  }
  return { subscriptionUrl: result.url };
}

export async function subscriptionDevices(userId: string, panel?: AssignmentPanel) {
  if (!panel?.getUserDevices) throw new AppError(503, "DEVICES_UNAVAILABLE");
  const before = await accessTarget(userId, panel, false);
  const id = Number(before.binding.remoteUserId);
  const remote = await panel.readBack(id).catch(() => { throw new AppError(503, "DEVICES_UNAVAILABLE"); });
  if (!remote || !bindingIdentityMatches(before.binding, remote) || remote.status !== "ACTIVE" ||
      !matchesProfile(remote, absoluteProfile(before.desired))) throw new AppError(409, "ACCESS_NOT_READY");
  const result = await panel.getUserDevices(id).catch(() => { throw new AppError(503, "DEVICES_UNAVAILABLE"); });
  const after = await accessTarget(userId, panel, false);
  if (before.desired.id !== after.desired.id || !bindingIdentityMatches(after.binding, remote)) {
    throw new AppError(409, "ACCESS_NOT_READY");
  }
  return {
    total: result.total, limit: remote.deviceLimit,
    items: result.devices.slice(0, 100).map(({ platform, deviceModel, createdAt, updatedAt }) => ({
      platform: platform?.slice(0, 80) ?? null, model: deviceModel?.slice(0, 120) ?? null,
      registeredAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
    })),
  };
}
