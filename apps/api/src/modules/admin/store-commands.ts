import type { Prisma } from "@prisma/client";
import { createPlanSchema, emailField, supportText, updatePlanSchema } from "@vpn/shared";
import { z } from "zod";
import { emailAvailable, env } from "../../config/env";
import { isUniqueViolation } from "../../lib/db-errors";
import { AppError } from "../../lib/errors";
import { consumeMailBudget, createEmailAccount, emailInUse, invalidatePasswordResets, issuePasswordReset, lockRegistration } from "../auth/auth.service";
import { hashPassword } from "../auth/password";
import { sha256 } from "../../lib/crypto";
import { VERIFY_TTL_MS } from "../auth/auth.constants";
import { lockIdentityOwner, revokeAllUserSessions } from "../auth/session.service";
import { dbNow, lockPlanForEdit, publishOffer, withdrawOffer } from "../commerce/offers";
import { scheduleRevisionVerification } from "../fulfillment/revision.queue";
import { hasPendingEvidence } from "../subscriptions/allocation";
import { releaseStoredHold, storeHold } from "../subscriptions/holds";
import { createSubscription, lockSubscription, projectAssignment } from "../subscriptions/store";
import { lockEntitlementAccount, lockOrder, noteCase } from "../payments/store";
import { command, expectVersion, type CommandContext } from "./commands";

const id = z.uuid();
const empty = z.strictObject({});
const currency = z.enum(["RUB", "USD", "XTR"]);
const amount = z.string().regex(/^[1-9][0-9]{0,17}$/);
const versionTarget = (ctx: CommandContext) => id.parse(ctx.targetId);
async function editable(ctx: CommandContext) {
  const plan = await lockPlanForEdit(ctx.db, versionTarget(ctx));
  expectVersion(ctx.expectedVersion, plan.revision);
  return plan;
}
async function bump(ctx: CommandContext) {
  return ctx.db.plan.update({ where: { id: ctx.targetId }, data: { revision: { increment: 1 } } });
}

async function refundSource(ctx: CommandContext, captureId: string) {
  const fact = await ctx.db.paymentTransaction.findUnique({ where: { id: captureId }, include: { payment: true } });
  const attempt = fact?.payment;
  if (!fact || fact.kind !== "CAPTURE" || !attempt || !fact.providerTime || attempt.orderId !== ctx.targetId ||
      fact.accountId !== attempt.accountId || fact.externalPaymentId !== attempt.externalId ||
      fact.merchantReference !== attempt.merchantReference) throw new AppError(409, "NOT_REFUNDABLE");
  await lockEntitlementAccount(ctx.db, fact.accountId);
  const order = await lockOrder(ctx.db, versionTarget(ctx));
  if (!order) throw new AppError(404, "NOT_FOUND");
  expectVersion(ctx.expectedVersion, order.updatedAt);
  if (await hasPendingEvidence(ctx.db, fact, order.id)) throw new AppError(409, "EVIDENCE_PENDING");
  const reversals = await ctx.db.paymentTransaction.findMany({ where: {
    accountId: fact.accountId, kind: { in: ["REFUND", "CHARGEBACK_DEBIT", "CHARGEBACK_REVERSAL"] },
    OR: [{ originalMovementKey: fact.movementKey }, { externalPaymentId: fact.externalPaymentId }],
  }, select: { originalMovementKey: true, kind: true, amountMinor: true, currency: true } });
  // Cases with an unlinked refund or a dispute require reconciliation before reserving.
  if (reversals.some(move => move.currency !== fact.currency || move.originalMovementKey !== fact.movementKey || move.kind !== "REFUND")) {
    throw new AppError(409, "NOT_REFUNDABLE");
  }
  const now = await dbNow(ctx.db);
  if (fact.providerTime > now) throw new AppError(409, "NOT_REFUNDABLE");
  const reserved = await ctx.db.refundIntent.aggregate({
    where: { captureId, OR: [{ approvedAt: { not: null } }, { expiresAt: { gt: now } }] }, _sum: { amountMinor: true },
  });
  const remaining = fact.amountMinor - reversals.reduce((sum, move) => sum + move.amountMinor, 0n) - (reserved._sum.amountMinor ?? 0n);
  return { fact, now, remaining };
}
function refundDto(row: { id: string; amountMinor: bigint; currency: string; expiresAt: Date; approvedAt: Date | null }) {
  return { refundId: row.id, amountMinor: row.amountMinor.toString(), currency: row.currency, expiresAt: row.expiresAt.toISOString(),
    status: row.approvedAt ? "APPROVED_WAITING_PROVIDER" : "AWAITING_APPROVAL" };
}

async function customerPassword(ctx: CommandContext) {
  const owner = await lockIdentityOwner(ctx.db, versionTarget(ctx));
  if (!owner || owner.role !== "USER" || await ctx.db.staffCredential.findUnique({ where: { userId: owner.id } }))
    throw new AppError(404, "NOT_FOUND");
  expectVersion(ctx.expectedVersion, owner.updatedAt);
  const credential = await ctx.db.authIdentity.findUnique({
    where: { userId_provider: { userId: owner.id, provider: "EMAIL" } },
    select: { id: true, providerId: true, passwordHash: true },
  });
  if (!credential?.passwordHash) throw new AppError(409, "PASSWORD_NOT_CONFIGURED");
  return { owner, credential };
}

export const storeCommands = {
  "plan.create": command("plans:write", createPlanSchema.strict(), async (ctx, input) => {
    expectVersion(ctx.expectedVersion, 0);
    if (ctx.targetId !== input.code) throw new AppError(400, "INVALID_TARGET");
    try {
      const plan = await ctx.db.plan.create({ data: input });
      return { id: plan.id, version: plan.revision };
    } catch (error) { if (isUniqueViolation(error)) throw new AppError(409, "CODE_TAKEN"); throw error; }
  }),
  "plan.publish": command("plans:write", z.strictObject({ name: z.string().trim().min(1).max(80), deviceLimit: z.number().int().min(1).max(100),
    durationMonths: z.union([z.literal(1), z.literal(3), z.literal(6)]), currency, amountMinor: z.number().int().min(1).max(100_000_000),
  }), async (ctx, input) => {
    const plan = await editable(ctx);
    if (!plan.isActive) throw new AppError(409, "PLAN_INACTIVE");
    const key = { planId: plan.id, currency: input.currency, durationMonths: input.durationMonths };
    const price = await ctx.db.planPrice.upsert({ where: { planId_durationMonths_currency: key },
      create: { ...key, amount: input.amountMinor }, update: { amount: input.amountMinor, isActive: true } });
    const offer = await publishOffer(ctx.db, { ...plan, name: input.name, deviceLimit: input.deviceLimit }, price, await dbNow(ctx.db));
    const after = await bump(ctx);
    return { id: offer.id, priceId: price.id, offerVersion: offer.version, version: after.revision, amountMinor: offer.amount,
      currency: offer.currency, durationMonths: offer.durationMonths, deviceLimit: offer.deviceLimit };
  }),
  "plan.update": command("plans:write", updatePlanSchema, async (ctx, input) => {
    const plan = await editable(ctx);
    const after = await ctx.db.plan.update({ where: { id: plan.id }, data: { ...input, revision: { increment: 1 } } });
    return { id: plan.id, version: after.revision, name: after.name, isActive: after.isActive, deviceLimit: after.deviceLimit };
  }),
  "plan.retire_offer": command("plans:write", z.strictObject({ offerId: id }), async (ctx, input) => {
    await editable(ctx);
    const offer = await ctx.db.offerVersion.findFirst({ where: { id: input.offerId, offer: { planId: ctx.targetId }, withdrawnAt: null } });
    if (!offer) throw new AppError(404, "OFFER_NOT_FOUND");
    await withdrawOffer(ctx.db, offer.planPriceId, await dbNow(ctx.db));
    await ctx.db.planPrice.update({ where: { id: offer.planPriceId }, data: { isActive: false } });
    return { id: offer.id, version: (await bump(ctx)).revision };
  }),
  "plan.retire": command("plans:write", empty, async ctx => {
    await editable(ctx);
    const now = await dbNow(ctx.db);
    await ctx.db.offerVersion.updateMany({ where: { offer: { planId: ctx.targetId }, withdrawnAt: null }, data: { withdrawnAt: now } });
    await ctx.db.planPrice.updateMany({ where: { planId: ctx.targetId }, data: { isActive: false } });
    const plan = await ctx.db.plan.update({ where: { id: ctx.targetId }, data: { isActive: false, revision: { increment: 1 } } });
    return { id: plan.id, version: plan.revision };
  }),

  "user.create": command("users:create", z.strictObject({ email: emailField }), async (ctx, input) => {
    expectVersion(ctx.expectedVersion, 0);
    if (ctx.targetId !== "new") throw new AppError(400, "INVALID_TARGET");
    await lockRegistration(ctx.db, input.email);
    if (await emailInUse(ctx.db, input.email)) throw new AppError(409, "USER_EMAIL_IN_USE");
    const existing = await ctx.db.pendingRegistration.findFirst({
      where: { email: input.email, passwordHash: null, expiresAt: { gt: ctx.now } }, select: { id: true },
    });
    const request = existing ?? await ctx.db.pendingRegistration.create({
      data: { email: input.email, expiresAt: new Date(+ctx.now + VERIFY_TTL_MS) }, select: { id: true },
    });
    return { id: request.id, active: false };
  }),
  "user.activate": command("users:write", empty, async ctx => {
    const owner = await lockIdentityOwner(ctx.db, versionTarget(ctx));
    if (!owner || owner.role !== "USER") throw new AppError(404, "NOT_FOUND");
    if (owner.status !== "ACTIVE") throw new AppError(409, "ACCOUNT_BLOCKED");
    if (!owner.activationRequired) return { id: owner.id, active: true, alreadyActive: true };
    expectVersion(ctx.expectedVersion, owner.updatedAt);
    await ctx.db.user.update({ where: { id: owner.id }, data: { activationRequired: false, manualActivatedAt: ctx.now } });
    return { id: owner.id, active: true, method: "MANUAL", activatedAt: ctx.now.toISOString() };
  }),
  "user.registration.activate": command("users:write", z.strictObject({ registrationReference: z.uuid() }), async (ctx, input) => {
    const pending = await ctx.db.pendingRegistration.findFirst({ where: { id: versionTarget(ctx), expiresAt: { gt: ctx.now } } });
    if (!pending) throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, pending.createdAt);
    if (!pending.passwordHash || pending.approvalHash !== sha256(input.registrationReference.toLowerCase()))
      throw new AppError(409, "REGISTRATION_REFERENCE_MISMATCH");
    await lockRegistration(ctx.db, pending.email);
    if (await emailInUse(ctx.db, pending.email)) throw new AppError(409, "USER_EMAIL_IN_USE");
    const consumed = await ctx.db.pendingRegistration.deleteMany({ where: { id: pending.id, expiresAt: { gt: await dbNow(ctx.db) } } });
    if (consumed.count !== 1) throw new AppError(409, "VERSION_CONFLICT");
    try {
      const user = await createEmailAccount(ctx.db, { email: pending.email, passwordHash: pending.passwordHash, manualActivatedAt: ctx.now });
      await ctx.db.pendingRegistration.deleteMany({ where: { email: pending.email } });
      return { id: user.id, active: true, method: "MANUAL", activatedAt: ctx.now.toISOString() };
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, "USER_EMAIL_IN_USE");
      throw error;
    }
  }),
  "user.registration.cancel": command("users:write", empty, async ctx => {
    const pending = await ctx.db.pendingRegistration.findUnique({ where: { id: versionTarget(ctx) } });
    if (!pending) throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, pending.createdAt);
    await lockRegistration(ctx.db, pending.email);
    const cancelled = await ctx.db.pendingRegistration.deleteMany({ where: { id: pending.id } });
    if (!cancelled.count) throw new AppError(409, "VERSION_CONFLICT");
    return { id: pending.id, cancelled: true };
  }),
  "user.password.set": command("users:write", z.strictObject({ password: z.string().min(10).max(128) }), async (ctx, input) => {
    const { owner, credential } = await customerPassword(ctx);
    await ctx.db.authIdentity.update({ where: { id: credential.id },
      data: { passwordHash: await hashPassword(input.password), temporaryPasswordExpiresAt: null }, select: { id: true } });
    await invalidatePasswordResets(ctx.db, owner.id, ctx.now);
    await ctx.db.identityProof.deleteMany({ where: { family: { userId: owner.id } } });
    await revokeAllUserSessions(owner.id, ctx.db);
    const updated = await ctx.db.user.update({ where: { id: owner.id },
      data: { updatedAt: new Date(Math.max(+ctx.now, +owner.updatedAt + 1)) }, select: { updatedAt: true } });
    return { id: owner.id, passwordChanged: true, sessionsRevoked: true, version: updated.updatedAt.toISOString() };
  }),
  "user.password.send_reset": command("users:write", empty, async ctx => {
    const { owner, credential } = await customerPassword(ctx);
    if (!emailAvailable || !env.MAIL_QUEUE_KEY) throw new AppError(503, "EMAIL_UNAVAILABLE");
    if (!owner.email || credential.providerId !== owner.email || !owner.emailVerifiedAt || owner.emailLoginDisabled || owner.status !== "ACTIVE")
      throw new AppError(409, "PASSWORD_RESET_UNAVAILABLE");
    if (!await consumeMailBudget(owner.email, "reset", ctx.db)) throw new AppError(429, "RATE_LIMIT_EXCEEDED");
    await issuePasswordReset(ctx.db, owner.id, owner.email, await dbNow(ctx.db));
    return { id: owner.id, resetQueued: true };
  }),
  "user.account_status": command("users:write", z.strictObject({ status: z.enum(["ACTIVE", "BLOCKED"]) }), async (ctx, input) => {
    const owner = await lockIdentityOwner(ctx.db, versionTarget(ctx));
    if (!owner || owner.role !== "USER" || await ctx.db.staffCredential.findUnique({ where: { userId: owner.id } })) throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, owner.updatedAt);
    const updated = await ctx.db.user.update({ where: { id: owner.id },
      data: { status: input.status, updatedAt: new Date(Math.max(+ctx.now, +owner.updatedAt + 1)) } });
    if (input.status === "BLOCKED") await revokeAllUserSessions(owner.id, ctx.db);
    return { id: owner.id, version: updated.updatedAt.toISOString(), from: owner.status, to: updated.status };
  }),
  "user.hold": command("access:write", z.strictObject({ kind: z.enum(["ADMIN", "FRAUD", "SERVICE_CONFLICT"]) }), async (ctx, input) => {
    const userId = versionTarget(ctx);
    const owner = await lockIdentityOwner(ctx.db, userId);
    if (!owner || owner.role !== "USER") throw new AppError(404, "NOT_FOUND");
    const subscription = await createSubscription(ctx.db, userId);
    expectVersion(ctx.expectedVersion, subscription.revision);
    const hold = await storeHold(ctx.db, subscription, await dbNow(ctx.db), {
      source: "staff:" + ctx.commandId, kind: input.kind, reason: ctx.reason, actorId: ctx.actor.userId,
    });
    const latest = await ctx.db.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    return { holdId: hold.id, version: latest.revision, kind: hold.kind };
  }),
  "user.release_hold": command("access:write", z.strictObject({ holdId: id }), async (ctx, input) => {
    const subscription = await lockSubscription(ctx.db, versionTarget(ctx));
    if (!subscription) throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, subscription.revision);
    const hold = await ctx.db.serviceHold.findFirst({ where: { id: input.holdId, subscriptionId: subscription.id } });
    if (!hold || !hold.source.startsWith("staff:")) throw new AppError(409, "HOLD_NOT_MANAGED");
    if (hold.releasedAt) throw new AppError(409, "HOLD_ALREADY_RELEASED");
    const result = await releaseStoredHold(ctx.db, subscription, await dbNow(ctx.db), hold.source, { actorId: ctx.actor.userId, reason: ctx.reason });
    return { holdId: result.id, releasedAt: result.releasedAt!.toISOString() };
  }),
  "job.requeue": command("jobs:write", empty, async ctx => {
    const job = await ctx.db.fulfillmentJob.findUnique({ where: { id: versionTarget(ctx) }, include: {
      assignment: { include: { subscription: { select: { userId: true } } } },
    } });
    if (!job?.assignment) throw new AppError(409, "LEGACY_JOB_REVIEW_REQUIRED");
    expectVersion(ctx.expectedVersion, job.assignment.revision);
    return scheduleRevisionVerification(ctx.db, job.assignment.subscription.userId, job.assignment.revision);
  }),
  "user.reconcile_access": command("jobs:write", empty, async ctx =>
    scheduleRevisionVerification(ctx.db, versionTarget(ctx), Number(ctx.expectedVersion))),
  "user.binding_review": command("bindings:write", z.strictObject({
    decision: z.enum(["KEEP_HOLD", "APPROVE_VERIFIED_BINDING"]), reviewId: z.string().regex(/^[A-Za-z0-9._-]{3,100}$/),
  }), async (ctx, input) => {
    const subscription = await lockSubscription(ctx.db, versionTarget(ctx));
    if (!subscription) throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, subscription.revision);
    const binding = await ctx.db.panelBinding.findUnique({ where: { subscriptionId: subscription.id } });
    if (!binding?.blockedReason || input.decision !== "KEEP_HOLD") throw new AppError(409, "BINDING_UNVERIFIED");
    return { reviewId: input.reviewId, subscriptionId: subscription.id, decision: input.decision };
  }),
  "order.reconcile": command("finance:reconcile", z.strictObject({ attemptId: id.optional() }), async (ctx, input) => {
    const order = await lockOrder(ctx.db, versionTarget(ctx));
    if (!order) throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, order.updatedAt);
    const rows = await ctx.db.payment.findMany({ where: { orderId: order.id, id: input.attemptId, accountId: { not: null } },
      select: { id: true, accountId: true }, orderBy: { id: "asc" }, take: 101 });
    if (!rows.length) throw new AppError(409, "NO_VERIFIED_ATTEMPT");
    if (rows.length > 100) throw new AppError(409, "SPECIFY_ATTEMPT");
    for (const row of rows) {
      await noteCase(ctx.db, { id: row.accountId! }, "MANUAL_RECONCILIATION", `attempt:${row.id}`, "OPERATOR_REQUEST",
        { orderId: order.id, attemptId: row.id }, ctx.now);
      await ctx.db.payment.update({ where: { id: row.id }, data: { nextCheckAt: ctx.now } });
    }
    return { scheduledAttempts: rows.length, providerExecution: "GATED" };
  }),
  "payment.case_review": command("finance:reconcile", z.strictObject({
    disposition: z.enum(["INVESTIGATING", "RESOLVED"]),
  }), async (ctx, input) => {
    const [row] = await ctx.db.$queryRaw<{ id: string; updatedAt: Date; kind: string }[]>`
      SELECT id, "updatedAt", kind FROM "PaymentCase" WHERE id = ${versionTarget(ctx)} FOR UPDATE`;
    if (!row) throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, row.updatedAt);
    if (input.disposition === "RESOLVED" && row.kind !== "MANUAL_RECONCILIATION") throw new AppError(409, "PROVIDER_EVIDENCE_REQUIRED");
    const updatedAt = new Date(Math.max(+await dbNow(ctx.db), +row.updatedAt + 1));
    await ctx.db.$executeRaw`UPDATE "PaymentCase" SET status = ${input.disposition}::"PaymentCaseStatus", "updatedAt" = ${updatedAt},
      history = history || jsonb_build_array(jsonb_build_object('status', ${input.disposition}::text, 'at', ${updatedAt.toISOString()}::text,
        'reason', ${ctx.reason}::text, 'actorId', ${ctx.actor.userId}::text)) WHERE id = ${row.id}`;
    return { id: row.id, status: input.disposition, version: updatedAt.toISOString() };
  }),
  "refund.request": command("finance:refund", z.strictObject({ captureId: id, amountMinor: amount, currency }), async (ctx, input) => {
    const { fact, now, remaining } = await refundSource(ctx, input.captureId);
    if (input.currency !== fact.currency || BigInt(input.amountMinor) > remaining) throw new AppError(409, "REFUND_LIMIT");
    const intent = await ctx.db.refundIntent.create({ data: { captureId: fact.id, commandId: ctx.commandId,
      initiatorId: ctx.actor.userId, amountMinor: BigInt(input.amountMinor), currency: input.currency, reason: ctx.reason,
      expiresAt: new Date(+now + 24 * 60 * 60_000), createdAt: now } });
    return refundDto(intent);
  }),
  "refund.approve": command("finance:refund", z.strictObject({ refundId: id }), async (ctx, input) => {
    const intent = await ctx.db.refundIntent.findUnique({ where: { id: input.refundId } });
    if (!intent) throw new AppError(404, "NOT_FOUND");
    if (intent.initiatorId === ctx.actor.userId) throw new AppError(409, "SAME_APPROVER");
    const { now, remaining } = await refundSource(ctx, intent.captureId);
    if (intent.approvedAt || intent.expiresAt <= now) throw new AppError(409, "ALREADY_DECIDED");
    if (remaining < 0n) throw new AppError(409, "REFUND_LIMIT");
    const updated = await ctx.db.refundIntent.update({ where: { id: intent.id },
      data: { approvedBy: ctx.actor.userId, approvedAt: now } });
    return refundDto(updated);
  }),
  "subscription.compensate": command("subscription:adjust", z.strictObject({
    incidentId: z.string().regex(/^[A-Za-z0-9._-]{3,100}$/), affectedPeriodId: id,
    durationSeconds: z.number().int().min(60).max(86_400 * 30),
  }), async (ctx, input) => {
    // B2 must be approved before a production time credit can affect entitlement.
    if (process.env.ADMIN_COMPENSATION_POLICY !== "incident-append-v1") throw new AppError(409, "COMPENSATION_POLICY_PENDING");
    const subscription = await lockSubscription(ctx.db, versionTarget(ctx));
    if (!subscription || subscription.legacyUnverified) throw new AppError(409, "INELIGIBLE_PERIOD");
    expectVersion(ctx.expectedVersion, subscription.revision);
    const basis = await ctx.db.periodGrant.findFirst({ where: {
      id: input.affectedPeriodId, subscriptionId: subscription.id, orderId: { not: null }, adjustment: { is: null },
    } });
    if (!basis) throw new AppError(409, "INELIGIBLE_PERIOD");
    if (await ctx.db.periodGrant.findUnique({ where: { subscriptionId_incidentId: { subscriptionId: subscription.id, incidentId: input.incidentId } } })) {
      throw new AppError(409, "INCIDENT_ALREADY_COMPENSATED");
    }
    const tail = await ctx.db.periodGrant.findFirst({ where: { subscriptionId: subscription.id }, orderBy: { serial: "desc" } });
    const now = await dbNow(ctx.db);
    const startAt = new Date(Math.max(+now, +(tail?.endAt ?? now)));
    const credit = await ctx.db.periodGrant.create({ data: { subscriptionId: subscription.id, serial: (tail?.serial ?? 0) + 1,
      incidentId: input.incidentId, basisGrantId: basis.id, compensationReason: ctx.reason, calendarVersion: 1,
      startAt, endAt: new Date(+startAt + input.durationSeconds * 1000), deviceLimit: basis.deviceLimit, createdAt: now } });
    const desired = await projectAssignment(ctx.db, subscription, now, "SERVICE_COMPENSATION", true);
    return { id: credit.id, startAt: startAt.toISOString(), endAt: credit.endAt.toISOString(), revision: desired.revision };
  }),
  "user.notice.send": command("users:write", z.strictObject({ title: supportText.max(120), body: supportText }), async (ctx, input) => {
    const user = await lockIdentityOwner(ctx.db, versionTarget(ctx));
    if (!user || user.role !== "USER") throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, user.updatedAt);
    const notice = await ctx.db.customerNotice.create({ data: { userId: user.id, ...input }, select: { id: true } });
    return { id: notice.id, userId: user.id, kind: "SERVICE" };
  }),
  "user.sessions.revoke": command("users:write", empty, async ctx => {
    const user = await lockIdentityOwner(ctx.db, versionTarget(ctx));
    if (!user || user.role !== "USER") throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, user.updatedAt);
    await revokeAllUserSessions(user.id, ctx.db);
    const { updatedAt } = await ctx.db.user.update({
      where: { id: user.id }, data: { updatedAt: new Date(Math.max(+ctx.now, +user.updatedAt + 1)) },
    });
    return { id: user.id, version: updatedAt.toISOString(), sessionsRevoked: true };
  }),
  "user.subscription_link_policy": command("access:write", z.strictObject({
    policy: z.enum(["INHERIT", "ALLOW", "DENY"]),
  }), async (ctx, input) => {
    const user = await lockIdentityOwner(ctx.db, versionTarget(ctx));
    if (!user || user.role !== "USER") throw new AppError(404, "NOT_FOUND");
    expectVersion(ctx.expectedVersion, user.updatedAt);
    const updated = await ctx.db.user.update({
      where: { id: user.id }, data: { subscriptionLinkPolicy: input.policy,
        updatedAt: new Date(Math.max(+ctx.now, +user.updatedAt + 1)) },
    });
    return { id: user.id, previous: user.subscriptionLinkPolicy, policy: updated.subscriptionLinkPolicy,
      version: updated.updatedAt.toISOString() };
  }),
  "settings.subscription_link_policy": command("settings:write", z.strictObject({ allowed: z.boolean() }), async (ctx, input) => {
    if (ctx.targetId !== "default") throw new AppError(400, "INVALID_TARGET");
    const id = "default";
    const old = await ctx.db.adminOperationalSettings.findUnique({ where: { id } });
    expectVersion(ctx.expectedVersion, old?.version ?? 0);
    const current = await ctx.db.adminOperationalSettings.upsert({ where: { id },
      create: { id, version: 1, subscriptionLinkAllowed: input.allowed },
      update: { version: { increment: 1 }, subscriptionLinkAllowed: input.allowed },
    });
    return { previous: old?.subscriptionLinkAllowed ?? true, allowed: current.subscriptionLinkAllowed, version: current.version };
  }),
  "settings.update": command("settings:write", z.strictObject({
    fulfillmentLagWarnSeconds: z.number().int().min(30).max(86_400),
    paymentLagWarnSeconds: z.number().int().min(30).max(86_400),
  }), async (ctx, input) => {
    const old = await ctx.db.adminOperationalSettings.findUnique({ where: { id: "default" } });
    expectVersion(ctx.expectedVersion, old?.version ?? 0);
    if (ctx.targetId !== "default") throw new AppError(400, "INVALID_TARGET");
    return ctx.db.adminOperationalSettings.upsert({ where: { id: "default" },
      create: { id: "default", version: 1, ...input }, update: { version: { increment: 1 }, ...input } }) as Promise<Prisma.InputJsonObject>;
  }),
};
