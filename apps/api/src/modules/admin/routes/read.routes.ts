import { Prisma, type JobStatus } from "@prisma/client";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { emailAvailable, env } from "../../../config/env";
import { AppError } from "../../../lib/errors";
import { keysetPage, keysetQuery, keysetWhere, newestFirst } from "../../../lib/keyset";
import { prisma } from "../../../lib/prisma";
import { subscriptionOverview } from "../../account/projections";
import { snapshot } from "../../commerce/orders";
import { adminOf, requireAdmin } from "../admin.middleware";
import { can } from "../admin.permissions";

const id = z.uuid();
const params = z.strictObject({ id });
const userStatus = z.enum(["ACTIVE", "BLOCKED"]);
const orderStatus = z.enum(["PENDING", "PAID", "FULFILLED", "EXPIRED", "CANCELED", "REFUNDED"]);
const jobStatus = z.enum(["PENDING", "RUNNING", "DONE", "FAILED", "CONFIRMED", "RETRY_WAIT", "VERIFY_PENDING", "NEEDS_REVIEW", "SUPERSEDED"]);
const pageScope = (name: string, filter: object) => JSON.stringify([name, filter]);
const missing = () => new AppError(404, "NOT_FOUND");
const mask = (email: string | null) => email ? email.slice(0, 1) + "•••@" + email.split("@").at(-1) : null;
const userSelect = { id: true, email: true, displayName: true, status: true, emailVerifiedAt: true,
  activationRequired: true, manualActivatedAt: true, createdAt: true, updatedAt: true } as const;
const publicUser = (row: Prisma.UserGetPayload<{ select: typeof userSelect }>, contact: boolean) => ({
  id: row.id, email: contact ? row.email : mask(row.email), status: row.status, displayName: row.displayName, emailVerified: !!row.emailVerifiedAt,
  activation: row.activationRequired ? "PENDING" : row.manualActivatedAt ? "MANUAL" : "ACTIVE", createdAt: row.createdAt, version: row.updatedAt,
});
const globalLookup = z.strictObject({ query: z.string().trim().min(2).max(160).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value)) });
const userLookup = z.union([globalLookup, z.strictObject({
  userId: id.optional(), verifiedEmail: z.email().transform(value => value.toLowerCase()).optional(),
}).refine(input => Boolean(input.userId) !== Boolean(input.verifiedEmail))]);

async function findCustomers(query: string, canReadOrders: boolean, canReadFinance: boolean) {
  const uuid = id.safeParse(query.toLowerCase());
  const email = z.email().safeParse(query.toLowerCase());
  const telegramId = /^\d{2,20}$/.test(query) ? query : undefined;
  const bound = 12;

  const [orderMatches, paymentMatches, subscriptionMatches, telegramMatches] = await Promise.all([
    canReadOrders && uuid.success ? prisma.order.findMany({
      where: { id: uuid.data }, select: { userId: true }, take: 1,
    }) : [],
    canReadFinance ? prisma.payment.findMany({
      where: { OR: [
        ...(uuid.success ? [{ id: uuid.data }] : []),
        { externalId: query }, { merchantReference: query },
      ], order: { user: { role: "USER" } } },
      select: { order: { select: { userId: true } } }, orderBy: { id: "asc" }, take: bound + 1,
    }) : [],
    uuid.success ? prisma.subscription.findMany({
      where: { id: uuid.data }, select: { userId: true }, take: 1,
    }) : [],
    telegramId ? prisma.authIdentity.findMany({
      where: { provider: "TELEGRAM", providerId: telegramId }, select: { userId: true }, take: 1,
    }) : [],
  ]);
  const users = [...new Set([
    ...orderMatches.map(row => row.userId), ...paymentMatches.map(row => row.order.userId),
    ...subscriptionMatches.map(row => row.userId), ...telegramMatches.map(row => row.userId),
    ...(uuid.success ? [uuid.data] : []),
  ])];
  const rows = await prisma.user.findMany({
    where: { role: "USER", OR: [
      { id: { in: users } },
      ...(email.success ? [{ email: email.data, emailVerifiedAt: { not: null } }] : []),
      { displayName: query },
    ] },
    select: userSelect, orderBy: newestFirst, take: bound + 1,
  });
  return { items: rows.slice(0, bound).map(row => publicUser(row, false)), nextCursor: null,
    truncated: rows.length > bound || paymentMatches.length > bound };
}
const jobSelect = {
  id: true, orderId: true, status: true, attempts: true, verificationEpoch: true, writes: true,
  nextAttemptAt: true, createdAt: true, completedAt: true, lastError: true,
  lease: { select: { expiresAt: true } },
  order: { select: { userId: true } },
  assignment: { select: { id: true, revision: true, enabled: true, deviceLimit: true, expiresAt: true,
    nextBoundaryAt: true, subscription: { select: { userId: true, revision: true } },
    grant: { select: { orderId: true } },
  } },
} as const;
const knownCode = (value: string | null) => value?.match(/^[A-Z0-9_]{1,80}$/) ? value : value ? "DETAIL_REDACTED" : null;
type Job = Prisma.FulfillmentJobGetPayload<{ select: typeof jobSelect }>;
const jobDto = (row: Job) => ({
  id: row.id, orderId: row.orderId ?? row.assignment?.grant?.orderId ?? null,
  userId: row.assignment?.subscription.userId ?? row.order?.userId ?? null,
  status: row.status, attempts: row.attempts, writes: row.writes, nextAttemptAt: row.nextAttemptAt,
  createdAt: row.createdAt, completedAt: row.completedAt, reasonCode: knownCode(row.lastError), leaseUntil: row.lease?.expiresAt ?? null,
  revision: row.assignment?.revision ?? null, currentRevision: row.assignment?.subscription.revision ?? null,
  assignmentId: row.assignment?.id ?? null, desired: row.assignment
    ? { enabled: row.assignment.enabled, expiresAt: row.assignment.expiresAt, deviceLimit: row.assignment.deviceLimit,
        nextBoundaryAt: row.assignment.nextBoundaryAt } : null,
});
const attemptSelect = {
  id: true, status: true, provider: true, amount: true, currency: true, createdAt: true, updatedAt: true,
  expiresAt: true, nextCheckAt: true, reasonCode: true, channel: true, accountId: true,
} as const;
const movementSelect = {
  id: true, kind: true, amountMinor: true, currency: true, providerTime: true, receivedAt: true, evidence: true,
  paymentId: true, allocation: { select: { id: true, orderId: true } },
} as const;
function movementDto(row: Prisma.PaymentTransactionGetPayload<{ select: typeof movementSelect }>) {
  return { ...row, amountMinor: row.amountMinor.toString() };
}
const periodSelect = {
  id: true, orderId: true, serial: true, createdAt: true, startAt: true, endAt: true, deviceLimit: true,
  adjustment: { select: { id: true, effectiveAt: true, reason: true } },
} as const;
const observationSelect = {
  id: true, revision: true, panelInstance: true, remoteUserId: true, status: true, expiresAt: true,
  deviceLimit: true, observedAt: true, receivedAt: true, comparison: true,
} as const;
type Observation = Prisma.PanelObservationGetPayload<{ select: typeof observationSelect }>;
const observationDto = (row: Observation) => ({ ...row, remoteUserId: row.remoteUserId?.toString() ?? null });
const bindingSelect = {
  panelInstance: true, remoteUserId: true, confirmedAt: true, confirmedRevision: true, blockedReason: true, disabledByShop: true,
} as const;
const orderInclude = {
  offerVersion: true,
  allocation: { select: { id: true, captureId: true, createdAt: true } },
  period: { select: { ...periodSelect, subscriptionId: true, subscription: { select: { revision: true } },
    assignments: { orderBy: { revision: "desc" as const }, take: 1, select: { revision: true, job: { select: jobSelect } } },
  } },
} satisfies Prisma.OrderInclude;
type Order = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
const orderDto = (row: Order) => ({
  id: row.id, userId: row.userId, status: row.status, createdAt: row.createdAt, expiresAt: row.expiresAt, version: row.updatedAt,
  snapshot: snapshot(row), allocated: !!row.allocation, periodId: row.period?.id ?? null,
  entitlement: row.period && { startAt: row.period.startAt, endsAt: row.period.adjustment?.effectiveAt ?? row.period.endAt },
  revision: row.period?.subscription.revision ?? null, delivery: row.period?.assignments[0]?.job?.status ?? "NOT_REQUESTED",
});

export const adminReadRoutes: FastifyPluginAsync = async app => {
  app.get("/users", { preHandler: requireAdmin("users:read") }, async req => {
    const { cursor, limit, status } = keysetQuery.extend({ status: userStatus.optional() }).parse(req.query);
    const scope = pageScope("admin-users", { status });
    const rows = await prisma.user.findMany({ where: { role: "USER", status, ...keysetWhere(scope, cursor) },
      select: userSelect, orderBy: newestFirst, take: limit + 1 });
    return keysetPage(scope, rows, limit, row => publicUser(row, false));
  });
  app.get("/users/registrations", { preHandler: requireAdmin("users:write") }, async req => {
    const { cursor, limit } = keysetQuery.parse(req.query);
    const scope = "admin-pending-registration";
    const rows = await prisma.pendingRegistration.findMany({ where: { expiresAt: { gt: new Date() }, ...keysetWhere(scope, cursor) },
      orderBy: newestFirst, take: limit + 1, select: { id: true, email: true, createdAt: true, expiresAt: true, passwordHash: true, approvalHash: true } });
    return keysetPage(scope, rows, limit, row => ({
      id: row.id, email: row.email, createdAt: row.createdAt, expiresAt: row.expiresAt, version: row.createdAt,
      state: !row.passwordHash ? "AWAITING_PASSWORD" : row.approvalHash ? "AWAITING_REVIEW" : "EMAIL_CONFIRMATION",
    }));
  });
  app.post("/users/search", { bodyLimit: 4096, preHandler: requireAdmin("users:read") }, async req => {
    const input = userLookup.parse(req.body);
    if ("query" in input) {
      const { role } = adminOf(req);
      return findCustomers(input.query, can(role, "orders:read"), can(role, "finance:read"));
    }
    const { userId, verifiedEmail } = input;
    const rows = await prisma.user.findMany({
      where: { role: "USER", id: userId, ...(verifiedEmail && { email: verifiedEmail, emailVerifiedAt: { not: null } }) },
      select: userSelect, take: 1,
    });
    return { items: rows.map(row => publicUser(row, false)), nextCursor: null };
  });
  app.get("/users/:id", { preHandler: requireAdmin("users:read") }, async req => {
    const userId = params.parse(req.params).id;
    const row = await prisma.user.findFirst({ where: { id: userId, role: "USER" },
      select: { ...userSelect, subscriptionLinkPolicy: true, emailLoginDisabled: true, identities: { select: { provider: true, providerId: true, verifiedAt: true, passwordHash: true } },
        subscription: { select: { id: true, revision: true, legacyUnverified: true, nextBoundaryAt: true,
          panelBinding: { select: bindingSelect },
          holds: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: {
            id: true, kind: true, createdAt: true, releasedAt: true, source: true, reason: true,
          } },
        } },
        _count: { select: { orders: true, supportCases: true } },
      },
    });
    if (!row) throw missing();
    const staff = can(adminOf(req).role, "users:write");
    const { subscription } = row;
    const password = row.identities.find(identity => identity.provider === "EMAIL" && !!identity.passwordHash);
    return { ...publicUser(row, staff),
      identities: row.identities.map(({ provider, verifiedAt }) => ({ provider, verifiedAt })), counts: row._count,
      ...(can(adminOf(req).role, "access:write") && { subscriptionLinkPolicy: row.subscriptionLinkPolicy }),
      ...(staff && { access: { hasPassword: !!password, mailAvailable: emailAvailable && !!env.MAIL_QUEUE_KEY,
        emailResetEligible: row.status === "ACTIVE" && !!row.emailVerifiedAt && !row.emailLoginDisabled && password?.providerId === row.email } }),
      right: (await subscriptionOverview(userId)).subscription?.rightStatus ?? "EMPTY",
      subscription: subscription && { id: subscription.id, revision: subscription.revision, legacy: subscription.legacyUnverified,
        nextBoundaryAt: subscription.nextBoundaryAt,
        binding: subscription.panelBinding && { ...subscription.panelBinding,
          remoteUserId: subscription.panelBinding.remoteUserId?.toString() ?? null },
        holds: subscription.holds.map(({ reason, source, ...hold }) => staff ? { ...hold, reason, source } : hold),
      },
    };
  });
  app.get("/users/:id/periods", { preHandler: requireAdmin("users:read") }, async req => {
    const userId = params.parse(req.params).id;
    const { cursor, limit } = keysetQuery.parse(req.query);
    if (!await prisma.user.findFirst({ where: { id: userId, role: "USER" }, select: { id: true } })) throw missing();
    const scope = "admin-periods:" + userId;
    const rows = await prisma.periodGrant.findMany({ where: { subscription: { userId }, ...keysetWhere(scope, cursor) },
      select: periodSelect, orderBy: newestFirst, take: limit + 1 });
    return keysetPage(scope, rows, limit, row => row);
  });
  app.get("/subscriptions", { preHandler: requireAdmin("users:read") }, async req => {
    const { cursor, limit, userId } = keysetQuery.extend({ userId: id.optional() }).parse(req.query);
    const scope = pageScope("admin-subscriptions", { userId });
    const rows = await prisma.subscription.findMany({
      where: { userId, ...keysetWhere(scope, cursor) },
      select: { id: true, userId: true, revision: true, createdAt: true, legacyUnverified: true, nextBoundaryAt: true,
        panelBinding: { select: { confirmedAt: true, confirmedRevision: true, blockedReason: true } },
        _count: { select: { holds: { where: { releasedAt: null } }, periods: true } },
      }, orderBy: newestFirst, take: limit + 1,
    });
    return keysetPage(scope, rows, limit, row => row);
  });

  app.get("/orders", { preHandler: requireAdmin("orders:read") }, async req => {
    const { limit, cursor, userId, status, from, to } = keysetQuery.extend({
      userId: id.optional(), status: orderStatus.optional(), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
    }).parse(req.query);
    const scope = pageScope("admin-orders", { userId, status, from, to });
    const rows = await prisma.order.findMany({ where: { userId, status, AND: [
      { createdAt: { gte: from, lt: to } }, keysetWhere(scope, cursor),
    ] }, orderBy: newestFirst, take: limit + 1, include: orderInclude });
    return keysetPage(scope, rows, limit, orderDto);
  });
  app.post("/orders/search", { preHandler: requireAdmin("orders:read") }, async req => {
    const { kind, value, merchantAccountId } = z.strictObject({
      kind: z.enum(["ORDER", "MERCHANT_REFERENCE", "TRANSACTION"]),
      value: z.string().trim().min(1).max(200), merchantAccountId: id.optional(),
    }).parse(req.body);
    if (kind !== "ORDER" && !can(adminOf(req).role, "finance:read")) throw new AppError(403, "FORBIDDEN");
    const where: Prisma.OrderWhereInput = kind === "ORDER" ? { id: value } : { payments: { some: {
      accountId: merchantAccountId, ...(kind === "MERCHANT_REFERENCE" ? { merchantReference: value } : { ledger: { some: { movementKey: value } } }),
    } } };
    const rows = await prisma.order.findMany({ where, take: 2, include: orderInclude });
    if (rows.length > 1) throw new AppError(409, "AMBIGUOUS_REFERENCE");
    return { items: rows.map(orderDto), nextCursor: null };
  });
  app.get("/orders/:id", { preHandler: requireAdmin("orders:read") }, async req => {
    const orderId = params.parse(req.params).id;
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
    if (!order) throw missing();
    const job = order.period?.assignments[0]?.job ??
      await prisma.fulfillmentJob.findUnique({ where: { orderId }, select: jobSelect });
    const [owner, attempts, observations] = await Promise.all([
      prisma.user.findUnique({ where: { id: order.userId }, select: userSelect }),
      prisma.payment.findMany({ where: { orderId }, select: attemptSelect, take: 25, orderBy: newestFirst }),
      job?.assignment ? prisma.panelObservation.findMany({ where: { assignmentId: job.assignment.id },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 10, select: observationSelect }) : [],
    ]);
    const finance = can(adminOf(req).role, "finance:read");
    return { ...orderDto(order), owner: owner && publicUser(owner, can(adminOf(req).role, "users:write")),
      allocation: order.allocation && { id: order.allocation.id, createdAt: order.allocation.createdAt,
        ...(finance && { captureId: order.allocation.captureId }) },
      period: order.period && { id: order.period.id, startAt: order.period.startAt, endAt: order.period.endAt, adjustment: order.period.adjustment },
      attempts: attempts.map(({ accountId, reasonCode, ...attempt }) => ({ ...attempt, reasonCode: knownCode(reasonCode), verified: accountId !== null })),
      job: job && jobDto(job), observations: observations.map(observationDto),
    };
  });

  app.get("/orders/:id/finance", { preHandler: requireAdmin("finance:read") }, async req => {
    const orderId = params.parse(req.params).id;
    const { limit, cursor, kind } = keysetQuery.extend({
      kind: z.enum(["attempts", "transactions", "refunds", "disputes"]).default("transactions"),
    }).parse(req.query);
    if (!await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })) throw missing();
    const scope = pageScope("admin-finance", { orderId, kind });
    if (kind === "attempts") {
      const rows = await prisma.payment.findMany({ where: { orderId, ...keysetWhere(scope, cursor) },
        orderBy: newestFirst, take: limit + 1, select: attemptSelect });
      return keysetPage(scope, rows, limit, row => ({ ...row, reasonCode: knownCode(row.reasonCode) }));
    }
    const rows = await prisma.paymentTransaction.findMany({
      where: { payment: { orderId }, kind: kind === "refunds" ? "REFUND" : kind === "disputes"
        ? { in: ["CHARGEBACK_DEBIT", "CHARGEBACK_REVERSAL"] } : undefined,
        AND: [moveCursor(scope, cursor)] },
      select: movementSelect, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: limit + 1,
    });
    return keysetPage(scope, rows.map(row => ({ ...row, createdAt: row.receivedAt })), limit, movementDto);
  });
  app.get("/payments/transactions", { preHandler: requireAdmin("finance:read") }, async req => {
    const { cursor, limit, currency, unallocated } = keysetQuery.extend({
      currency: z.enum(["RUB", "USD", "XTR"]).optional(), unallocated: z.enum(["true", "false"]).optional(),
    }).parse(req.query);
    const scope = pageScope("admin-movements", { currency, unallocated });
    const rows = await prisma.paymentTransaction.findMany({ where: { currency,
      ...(unallocated === "true" && { kind: "CAPTURE", allocation: { is: null } }), ...moveCursor(scope, cursor),
    }, select: movementSelect, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: limit + 1 });
    return keysetPage(scope, rows.map(row => ({ ...row, createdAt: row.receivedAt })), limit, movementDto);
  });
  app.get("/payments/cases", { preHandler: requireAdmin("finance:read") }, async req => {
    const { limit, cursor, status } = keysetQuery.extend({ status: z.enum(["OPEN", "INVESTIGATING", "RESOLVED"]).optional() }).parse(req.query);
    const scope = pageScope("admin-payment-cases", { status });
    const rows = await prisma.paymentCase.findMany({ where: { status, ...keysetWhere(scope, cursor) },
      select: { id: true, kind: true, status: true, priority: true, createdAt: true, updatedAt: true, nextCheckAt: true },
      orderBy: newestFirst, take: limit + 1 });
    return keysetPage(scope, rows, limit, row => ({ ...row, version: row.updatedAt }));
  });
  app.get("/payments/cases/:id", { preHandler: requireAdmin("finance:read") }, async req => {
    const caseId = params.parse(req.params).id;
    const row = await prisma.paymentCase.findUnique({ where: { id: caseId }, select: {
      id: true, kind: true, status: true, priority: true, createdAt: true, updatedAt: true, nextCheckAt: true,
      history: true,
    } });
    if (!row) throw missing();
    const history = z.array(z.object({ status: z.string(), at: z.string().optional() })).safeParse(row.history);
    return { ...row, version: row.updatedAt, history: history.success ? history.data.slice(-50) : [] };
  });
  app.get("/jobs/:id", { preHandler: requireAdmin("jobs:read") }, async req => {
    const jobId = params.parse(req.params).id;
    const row = await prisma.fulfillmentJob.findUnique({ where: { id: jobId }, select: jobSelect });
    if (!row) throw missing();
    const observations = row.assignment ? await prisma.panelObservation.findMany({
      where: { assignmentId: row.assignment.id }, orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 50, select: observationSelect,
    }) : [];
    return { ...jobDto(row), observations: observations.map(observationDto) };
  });
};

const moveCursor = (scope: string, cursor: string | undefined) => {
  const filter = keysetWhere(scope, cursor);
  return filter.OR ? {
    OR: filter.OR.map(({ createdAt, id }) => ({ receivedAt: createdAt, id })),
  } : {};
};

export const adminJobsReadRoutes: FastifyPluginAsync = async app => {
  app.get("/jobs", { preHandler: requireAdmin("jobs:read") }, async req => {
    const { limit, cursor, status, userId, orderId, revision, overdue } = keysetQuery.extend({
      status: jobStatus.optional(), userId: id.optional(), orderId: id.optional(),
      revision: z.coerce.number().int().min(1).optional(), overdue: z.enum(["true", "false"]).optional(),
    }).parse(req.query);
    const scope = pageScope("admin-jobs", { status, userId, orderId, revision, overdue });
    const filters: Prisma.FulfillmentJobWhereInput[] = [keysetWhere(scope, cursor)];
    if (userId) filters.push({ OR: [{ order: { userId } }, { assignment: { subscription: { userId } } }] });
    if (orderId) filters.push({ OR: [{ orderId }, { assignment: { grant: { orderId } } }] });
    if (revision !== undefined) filters.push({ assignment: { revision } });
    const rows = await prisma.fulfillmentJob.findMany({ where: { status: status as JobStatus | undefined, AND: filters,
      ...(overdue === "true" && { nextAttemptAt: { lt: new Date() }, status: status ?? { in: ["PENDING", "VERIFY_PENDING", "RETRY_WAIT"] } }),
    }, select: jobSelect, orderBy: newestFirst, take: limit + 1 });
    return keysetPage(scope, rows, limit, jobDto);
  });
};
