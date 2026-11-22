import { Prisma } from "@prisma/client";
import type { OwnerOrderSummary, OwnerPayment, OwnerPeriod, OwnerSubscription } from "@vpn/shared";
import { prisma } from "../../lib/prisma";
import { keysetPage, keysetWhere, newestFirst } from "../../lib/keyset";
import { AppError } from "../../lib/errors";
import { dbNow } from "../commerce/offers";
import { snapshot } from "../commerce/orders";
import { driftIntervalMs } from "../fulfillment/revision.queue";

const periodInclude = { adjustment: true, order: { include: { offerVersion: true } } } as const;
type PeriodRow = Prisma.PeriodGrantGetPayload<{ include: typeof periodInclude }>;
const boundary = (grant: Pick<PeriodRow, "endAt" | "adjustment">) => grant.adjustment?.effectiveAt ?? grant.endAt;
const periodDto = (grant: PeriodRow): OwnerPeriod => ({
  id: grant.id, orderId: grant.orderId, serial: grant.serial, startAt: grant.startAt.toISOString(), endAt: grant.endAt.toISOString(),
  effectiveEndAt: boundary(grant).toISOString(), snapshot: snapshot(grant.order),
  adjustments: grant.adjustment ? [{ id: grant.adjustment.id, effectiveAt: grant.adjustment.effectiveAt.toISOString(), kind: grant.adjustment.reason }] : [],
});

export async function subscriptionOverview(userId: string): Promise<OwnerSubscription> {
  return prisma.$transaction(async db => {
    const now = await dbNow(db);
    const serverTime = now.toISOString();
    const sub = await db.subscription.findUnique({ where: { userId }, include: {
      holds: { where: { releasedAt: null }, select: { id: true }, take: 1 }, panelBinding: true,
    } });
    if (!sub) return { serverTime, subscription: null };
    const inScope = await db.periodGrant.findMany({
      where: { subscriptionId: sub.id, endAt: { gt: now } }, orderBy: { startAt: "asc" }, include: periodInclude,
    });
    const remaining = inScope.filter(grant => boundary(grant) > now && boundary(grant) > grant.startAt);
    const active = remaining[0] && remaining[0].startAt <= now ? remaining[0] : null;
    let end = active ? boundary(active) : null;
    for (const grant of remaining.slice(1)) {
      if (!end || grant.startAt > end) break;
      end = boundary(grant);
    }
    const tail = await db.periodGrant.findFirst({ where: { subscriptionId: sub.id }, orderBy: { serial: "desc" } });
    const last = remaining.at(-1);
    const assignment = await db.desiredAssignment.findUnique({ where: { subscriptionId_revision: {
      subscriptionId: sub.id, revision: sub.revision,
    } }, include: { job: true } });
    const observedAt = sub.panelBinding?.confirmedAt ?? null;
    const observationFresh = !!observedAt && +now - +observedAt <= 2 * driftIntervalMs &&
      sub.panelBinding?.confirmedRevision === sub.revision && assignment?.job?.status === "CONFIRMED";
    const rightStatus = sub.legacyUnverified ? "LEGACY_REVIEW" : sub.holds.length || sub.panelBinding?.blockedReason ? "HELD"
      : active ? "ACTIVE" : remaining.length ? "SCHEDULED" : tail ? "EXPIRED" : "EMPTY";
    const delivery = rightStatus === "LEGACY_REVIEW" || assignment?.job?.status === "NEEDS_REVIEW" ? "REVIEW"
      : rightStatus === "HELD" ? "HELD" : rightStatus === "EXPIRED" ? "EXPIRED" : rightStatus === "SCHEDULED" ? "SCHEDULED"
      : rightStatus === "EMPTY" ? "NOT_REQUESTED"
      : observationFresh && assignment?.enabled && assignment.grantId === active?.id ? "READY" : "WAITING";
    return { serverTime, subscription: { id: sub.id, rightStatus, currentPeriod: active && periodDto(active),
      coverageEndsAt: end?.toISOString() ?? null, paidThroughAt: last ? boundary(last).toISOString() : null,
      nextBoundaryAt: sub.nextBoundaryAt?.toISOString() ?? null, delivery: {
        status: delivery, observedAt: observedAt?.toISOString() ?? null, observationFresh,
        reasonCode: sub.panelBinding?.blockedReason ?? assignment?.job?.lastError ?? null,
      },
    } };
  }, { isolationLevel: "RepeatableRead" });
}

export async function listPeriods(userId: string, limit: number, cursor?: string) {
  const scope = `periods:${userId}`;
  const rows = await prisma.periodGrant.findMany({ where: {
    subscription: { userId }, ...keysetWhere(scope, cursor),
  }, include: periodInclude, orderBy: newestFirst, take: limit + 1 });
  return keysetPage(scope, rows, limit, periodDto);
}

const orderInclude = {
  offerVersion: true, allocation: true,
  payments: { select: { accountId: true, status: true, ledger: {
    select: { id: true, kind: true, amountMinor: true, currency: true, providerTime: true },
  } } },
  period: { include: { adjustment: true, subscription: { include: {
    panelBinding: true, holds: { where: { releasedAt: null }, select: { id: true }, take: 1 },
  } }, assignments: { include: { job: true }, orderBy: { revision: "desc" }, take: 1 } } },
} satisfies Prisma.OrderInclude;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

function projectOrder(order: OrderRow, now: Date) {
  const ledger = order.payments.flatMap(payment => payment.ledger);
  const captures = ledger.filter(fact => fact.kind === "CAPTURE");
  const refunds = ledger.filter(fact => fact.kind === "REFUND");
  const grant = order.period;
  const sub = grant?.subscription;
  const assignment = grant?.assignments[0];
  const moneyStatus = captures.some(fact => !fact.providerTime || fact.providerTime >= order.expiresAt) ? "LATE_CAPTURE"
    : captures.some(fact => fact.currency !== order.currency || fact.amountMinor !== BigInt(order.amount)) ||
      captures.length > 1 || ledger.some(fact => fact.kind === "CHARGEBACK_DEBIT") ? "REVIEW"
    : refunds.reduce((total, refund) => total + (refund.currency === order.currency ? refund.amountMinor : 0n), 0n) >= BigInt(order.amount) ? "REFUNDED"
    : refunds.length ? "PARTIAL_REFUND" : captures.length ? "CAPTURE_RECORDED"
    : order.payments.some(payment => ["UNKNOWN", "SUBMITTING"].includes(payment.status)) ? "UNKNOWN"
    : order.status === "PAID" || order.status === "FULFILLED" || order.status === "REFUNDED" ? "LEGACY" : "WAITING";
  const confirmed = sub?.panelBinding?.confirmedAt;
  const deliveryStatus = !grant ? order.allocation ? "WAITING" : "NOT_REQUESTED"
    : boundary(grant) <= now ? "EXPIRED" : sub?.holds.length || sub?.panelBinding?.blockedReason ? "HELD"
    : grant.startAt > now ? "SCHEDULED"
    : assignment?.job?.status === "NEEDS_REVIEW" ? "REVIEW"
    : assignment?.job?.status === "CONFIRMED" && sub?.revision === assignment.revision &&
      assignment.revision === sub?.panelBinding?.confirmedRevision && confirmed && +now - +confirmed <= 2 * driftIntervalMs
      ? "READY" : "WAITING";
  const orderState = order.allocation ? "ALLOCATED" : order.status === "CANCELED" ? "CANCELED"
    : order.status === "EXPIRED" || (order.status === "PENDING" && order.expiresAt <= now) ? "EXPIRED"
    : order.status === "PENDING" ? "OPEN" : "LEGACY";
  const summary = {
    id: order.id, createdAt: order.createdAt.toISOString(), expiresAt: order.expiresAt.toISOString(),
    snapshot: snapshot(order), orderStatus: order.status, orderState, moneyStatus, deliveryStatus, periodId: grant?.id ?? null,
  } satisfies OwnerOrderSummary;
  return { summary, refunds: refunds.map(row => ({
    id: row.id, amountMinor: row.amountMinor.toString(), currency: row.currency, confirmedAt: row.providerTime?.toISOString() ?? null,
  })) };
}

export async function listOrders(userId: string, limit: number, cursor?: string) {
  const scope = `orders:${userId}`;
  const now = await dbNow(prisma);
  const rows = await prisma.order.findMany({ where: { userId, ...keysetWhere(scope, cursor) },
    include: orderInclude, orderBy: newestFirst, take: limit + 1 });
  return keysetPage(scope, rows, limit, order => projectOrder(order, now).summary);
}

export async function orderProjection(userId: string, id: string, now: Date) {
  const order = await prisma.order.findFirst({ where: { id, userId }, include: orderInclude });
  if (!order) throw new AppError(404, "NOT_FOUND");
  const entry = projectOrder(order, now);
  return { ...entry.summary, refunds: entry.refunds };
}

export async function listPayments(userId: string, orderId: string, limit: number, cursor?: string) {
  if (!await prisma.order.findFirst({ where: { id: orderId, userId }, select: { id: true } })) {
    throw new AppError(404, "NOT_FOUND");
  }
  const scope = `payments:${userId}:${orderId}`;
  const rows = await prisma.payment.findMany({ where: { orderId, ...keysetWhere(scope, cursor) },
    orderBy: newestFirst, take: limit + 1, include: { ledger: { where: { kind: "CAPTURE" },
      select: { id: true, amountMinor: true, currency: true, providerTime: true } } } });
  return keysetPage(scope, rows, limit, (row): OwnerPayment => ({
    id: row.id, channel: row.channel === "CARD" || row.channel === "SBP" ? row.channel : null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null, reasonCode: row.reasonCode,
    status: !row.accountId || row.status === "PAID" || row.status === "PENDING" || row.status === "REFUNDED" ? "LEGACY" : row.status,
    confirmedCaptures: row.ledger.map(fact => ({ id: fact.id, amountMinor: fact.amountMinor.toString(),
      currency: fact.currency, confirmedAt: fact.providerTime?.toISOString() ?? null })),
  }));
}
