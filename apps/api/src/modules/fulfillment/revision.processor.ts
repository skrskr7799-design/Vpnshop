import { isUniqueViolation } from "../../lib/db-errors";
import { randomUUID } from "node:crypto";
import type { DesiredAssignment, PanelBinding } from "@prisma/client";
import { matchesProfile, type AbsoluteProfile, type AssignmentPanel, type PanelUser } from "../remnawave/remnawave.assignment";
import { RemnawaveError } from "../remnawave/remnawave.errors";
import { remnawaveUsernameFor } from "../remnawave/remnawave.username";
import { backoffMs } from "./fulfillment.backoff";
import { LeaseLost } from "./fulfillment.queue";
import {
  bindingIdentityMatches, driftIntervalMs, guardedRevision, markDispatch, requestRevisionCheck,
  LeaseWindowTooShort, RevisionReview, settleRevision, Superseded, type RevisionJob,
} from "./revision.queue";

const maxAttempts = 8;

export function absoluteProfile(desired: DesiredAssignment): AbsoluteProfile {
  if (!desired.expiresAt || desired.deviceLimit === null) throw new RevisionReview("INVALID_TARGET_PROFILE");
  return { expiresAt: desired.expiresAt, deviceLimit: desired.deviceLimit, squads: desired.internalSquads };
}

export async function processRevision(job: RevisionJob, panel: AssignmentPanel) {
  let observed: PanelUser | null | undefined;
  let observedAt: Date | undefined;
  let sentWrite = false;
  let disableConfirmed = false;
  let writeAmbiguous = false;
  const budget = panel.timeoutMs + 250;
  const guard = () => guardedRevision(job, budget, async () => {});
  const read = async (binding: PanelBinding) => {
    await guard();
    observed = binding.remoteUserId === null ? await panel.findUser(binding.username) :
      await panel.readBack(Number(binding.remoteUserId));
    observedAt = new Date();
    if (observed && (!bindingIdentityMatches(binding, observed) ||
        (binding.remoteUserId === null && !binding.createDispatched))) {
      throw new RevisionReview("PANEL_IDENTITY_CONFLICT");
    }
    if (!observed && binding.remoteUserId !== null) throw new RevisionReview("BOUND_USER_MISSING");
    return observed;
  };
  const write = async (action: () => Promise<void>, changes?: Parameters<typeof markDispatch>[2]) => {
    await markDispatch(job, budget, changes);
    sentWrite = true;
    writeAmbiguous = true;
    await action();
    // A verified read after the call decides whether the command converged.
  };

  async function ensureBound(binding: PanelBinding, user: PanelUser) {
    if (binding.remoteUserId !== null) return binding;
    return guardedRevision(job, 0, async db => {
      const changed = await db.panelBinding.updateMany({
        where: { subscriptionId: job.subscriptionId, remoteUserId: null, createDispatched: true },
        data: { remoteUserId: BigInt(user.id) },
      });
      if (!changed.count) throw new RevisionReview("PANEL_BINDING_CHANGED");
      return db.panelBinding.findUniqueOrThrow({ where: { subscriptionId: job.subscriptionId } });
    });
  }

  try {
    if (job.attempts > maxAttempts) throw new RevisionReview("ATTEMPT_BUDGET_EXHAUSTED");
    const target = await guardedRevision(job, budget, async (db, desired) => {
      const username = `stg_${remnawaveUsernameFor(job.userId).slice(3)}`;
      await db.panelBinding.createMany({ data: [{
        subscriptionId: job.subscriptionId, panelInstance: panel.instance, origin: panel.origin, username,
        marker: `vpnshop:${panel.instance}:${randomUUID()}`,
      }], skipDuplicates: true });
      const binding = await db.panelBinding.findUnique({ where: { subscriptionId: job.subscriptionId } });
      if (!binding || binding.panelInstance !== panel.instance || binding.origin !== panel.origin) {
        throw new RevisionReview("PANEL_INSTALLATION_CONFLICT");
      }
      return { desired, binding };
    });
    let { binding } = target;
    if (binding.blockedReason && target.desired.enabled) throw new RevisionReview(binding.blockedReason);
    let user = await read(binding);
    if (!user && target.desired.enabled) {
      const profile = absoluteProfile(target.desired);
      await write(() => panel.createUser(binding.username, binding.marker, profile), { createDispatched: true });
      binding = { ...binding, createDispatched: true };
      user = await read(binding);
      if (!user) throw new RemnawaveError("unavailable", null, "Create requires read-back");
    }
    if (user) {
      binding = await ensureBound(binding, user);
      if (!target.desired.enabled) {
        if (user.status !== "DISABLED") {
          const id = user.id;
          // Clear provenance ahead of dispatch. An ambiguous disable cannot authorize a future enable.
          await write(() => panel.disableUser(id), { disabledByShop: false });
          user = await read(binding);
          disableConfirmed = user?.status === "DISABLED";
        }
      } else {
        const profile = absoluteProfile(target.desired);
        if (user.status === "LIMITED") throw new RevisionReview("PANEL_LIMITED");
        if (user.status === "DISABLED" && !binding.disabledByShop) throw new RevisionReview("MANUAL_DISABLE_REVIEW");
        if (!matchesProfile(user, profile)) {
          const id = user.id;
          await write(() => panel.updateAbsoluteProfile(id, profile));
          user = await read(binding);
        }
        if (user?.status === "DISABLED" && binding.disabledByShop) {
          if (!matchesProfile(user, profile)) throw new RevisionReview("PROFILE_MISMATCH_BEFORE_ENABLE");
          const id = user.id;
          // Consume the permit before sending enable.
          await write(() => panel.enableUser(id), { disabledByShop: false });
          user = await read(binding);
        } else if (user?.status === "DISABLED") {
          throw new RevisionReview("MANUAL_DISABLE_REVIEW");
        }
      }
    }
    const matched = target.desired.enabled
      ? user?.status === "ACTIVE" && matchesProfile(user, absoluteProfile(target.desired))
      : !user || user.status === "DISABLED";
    if (!matched) throw new RemnawaveError("unavailable", null, "Read-back differs from assignment");
    writeAmbiguous = false;
    const settled = await settleRevision(job, panel.instance, {
      status: "CONFIRMED", code: "MATCHED", delayMs: driftIntervalMs, observed, observedAt,
      bindingPatch: disableConfirmed ? { disabledByShop: true } : target.desired.enabled ? { disabledByShop: false } : undefined,
    });
    if (!settled && sentWrite) await requestRevisionCheck(job);
  } catch (error) {
    if (error instanceof LeaseLost) {
      if (sentWrite) await requestRevisionCheck(job);
      return;
    }
    const stale = error instanceof Superseded;
    const identityConflict = isUniqueViolation(error);
    const review = error instanceof RevisionReview || identityConflict ||
      (error instanceof RemnawaveError && (error.kind === "unauthorized" || (!error.retryable && !sentWrite)));
    const code = stale ? "REVISION_CHANGED" : error instanceof LeaseWindowTooShort ? "LEASE_DEADLINE"
      : error instanceof RevisionReview ? error.message
      : identityConflict ? "PANEL_IDENTITY_CONFLICT"
      : error instanceof RemnawaveError ? `PANEL_${error.kind.toUpperCase()}` : "SYNC_INTERRUPTED";
    const manualBlock = ["MANUAL_DISABLE_REVIEW", "PANEL_IDENTITY_CONFLICT", "BOUND_USER_MISSING"].includes(code);
    const status = stale ? "SUPERSEDED" : review || job.attempts >= maxAttempts ? "NEEDS_REVIEW"
      : writeAmbiguous || sentWrite ? "VERIFY_PENDING" : "RETRY_WAIT";
    const settled = await settleRevision(job, panel.instance, {
      status, code, observed, observedAt, delayMs: stale ? 1000 : backoffMs(job.attempts),
      bindingPatch: manualBlock ? { blockedReason: code } : undefined,
    });
    if (!settled && sentWrite) await requestRevisionCheck(job);
  }
}
