import type { FastifyPluginAsync } from "fastify";
import { overdueJobs, registrationCohort, stuckPayments } from "../operational-filters";
import { emailAvailable, env } from "../../../config/env";
import { z } from "zod";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { dbNow } from "../../commerce/offers";
import type { RemnawaveClient } from "../../remnawave/remnawave.client";
import { adminOf, requireAdmin } from "../admin.middleware";
import { can } from "../admin.permissions";

export type DashboardDeps = { panel: Pick<RemnawaveClient, "getMetadata"> };
const DAY = 86_400_000;
const filters = z.strictObject({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional() });
type SourceState = "FRESH" | "STALE" | "UNAVAILABLE";
const block = <T>(data: T | null, observedAt: Date | null, state: SourceState = "FRESH", reasonCode: string | null = null) =>
  ({ data, observedAt, state, reasonCode });

export const adminDashboardRoutes: FastifyPluginAsync<DashboardDeps> = async (app, { panel }) => {
  let cached: ReturnType<typeof block<{ version: string }>> | undefined;
  let pending: Promise<NonNullable<typeof cached>> | undefined;
  let lastCheck = 0;
  async function panelHealth() {
    if (env.REMNAWAVE_ENABLED === false) return block<{ version: string }>(null, null, "UNAVAILABLE", "PANEL_DISABLED");
    if (cached && Date.now() - lastCheck < 30_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const metadata = await Promise.race([
          panel.getMetadata(), new Promise<never>((_, reject) => { timer = setTimeout(reject, 5000); }),
        ]);
        cached = block({ version: metadata.version }, new Date());
      } catch {
        cached = cached?.observedAt
          ? block(cached.data, cached.observedAt, "STALE", "PANEL_PROBE_FAILED")
          : block<{ version: string }>(null, null, "UNAVAILABLE", "PANEL_UNAVAILABLE");
      } finally { clearTimeout(timer); lastCheck = Date.now(); }
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  }

  async function health() {
    const [panelStatus, rows] = await Promise.all([
      panelHealth(), prisma.workerHeartbeat.findMany({ orderBy: { observedAt: "desc" }, take: 50 }),
    ]);
    const cutoff = Date.now() - 60_000;
    const latest = rows.find(row => row.ready && +row.observedAt > cutoff) ?? rows[0];
    const worker = !latest ? block(null, null, "UNAVAILABLE", "NO_HEARTBEAT")
      : +latest.observedAt <= cutoff ? block(null, latest.observedAt, "STALE", "WORKER_STALE")
      : latest.ready ? block({ ready: true }, latest.observedAt) : block(null, latest.observedAt, "UNAVAILABLE", "WORKER_NOT_READY");
    return { panel: panelStatus, worker };
  }
  app.get("/operations/status", { preHandler: requireAdmin("ops:read") }, async req => {
    const [sources, unresolved] = await Promise.all([
      health(), can(adminOf(req).role, "finance:read") ? prisma.payment.count({ where: {
        provider: "PLATEGA",
        OR: [{ account: { is: { environment: { not: "MOCK" } } } }, { accountId: null, externalId: { not: null } }],
        status: { in: ["PENDING", "CREATED", "SUBMITTING", "AWAITING_CUSTOMER", "PROCESSING", "UNKNOWN"] },
      } }) : 0,
    ]);
    const product = {
      registration: env.REGISTRATION_ENABLED, payments: false, support: env.SUPPORT_ENABLED,
      maintenance: env.MAINTENANCE_MODE,
      remnawave: env.REMNAWAVE_ENABLED === false ? "DISABLED" :
        process.env.REMNAWAVE_REVISION_MODE === "staging" ? "CONFIGURED_UNVERIFIED" : "DISABLED",
      smtp: emailAvailable ? "CONFIGURED_UNVERIFIED" : "DISABLED",
      google: process.env.V2_GOOGLE_CONFIGURED === "true" ? "CONFIGURED_UNVERIFIED" : "DISABLED",
      telegram: process.env.V2_TELEGRAM_CONFIGURED === "true" ? "CONFIGURED_UNVERIFIED" : "DISABLED",
      platega: unresolved ? "OBLIGATIONS_WITHOUT_PROVIDER" : "CONTRACT_BLOCKED",
      runtimeConfigVersion: 1,
    };
    return { product, asOf: new Date(), services: Object.entries(sources).map(([key, value]) => ({ key, ...value })),
      alerts: Object.entries(sources).flatMap(([kind, value]) => value.state === "FRESH" || value.reasonCode === "PANEL_DISABLED" ? [] :
        [{ id: kind, kind, severity: "WARNING", since: value.observedAt, reasonCode: value.reasonCode }]) };
  });

  app.get("/dashboard", { preHandler: requireAdmin("dashboard:read") }, async req => {
    const input = filters.parse(req.query);
    const financeAllowed = can(adminOf(req).role, "finance:read");
    const data = await prisma.$transaction(async db => {
      const asOf = await dbNow(db);
      const to = input.to ? new Date(input.to) : asOf;
      const from = input.from ? new Date(input.from) : new Date(+to - 30 * DAY);
      if (+from >= +to || +to - +from > 366 * DAY || to > asOf) throw new AppError(400, "INVALID_RANGE");
      const range = { gte: from, lt: to };
      const users = { total: await db.user.count({ where: { role: "USER", createdAt: { lte: asOf } } }),
        new: await db.user.count({ where: registrationCohort(from, to) }),
        ...(financeAllowed && { paidInWindow: await db.user.count({ where: registrationCohort(from, to, true) }) }) };
      const [subscriptions] = await db.$queryRaw<{ active: number; panelReady: number }[]>`
        SELECT COUNT(*)::int AS active,
          COUNT(*) FILTER (WHERE b."confirmedRevision" = s.revision AND j.status = 'CONFIRMED'
            AND b."confirmedAt" >= ${new Date(+asOf - 120_000)} AND b."blockedReason" IS NULL)::int AS "panelReady"
        FROM "Subscription" s JOIN "PeriodGrant" g ON g."subscriptionId" = s.id
        LEFT JOIN "Adjustment" a ON a."grantId" = g.id
        LEFT JOIN "PanelBinding" b ON b."subscriptionId" = s.id
        LEFT JOIN "DesiredAssignment" d ON d."subscriptionId" = s.id AND d.revision = s.revision AND d."grantId" = g.id
        LEFT JOIN "FulfillmentJob" j ON j."assignmentId" = d.id
        WHERE g."startAt" <= ${asOf} AND COALESCE(a."effectiveAt",g."endAt") > ${asOf} AND NOT s."legacyUnverified"
          AND NOT EXISTS (SELECT 1 FROM "ServiceHold" h WHERE h."subscriptionId" = s.id AND h."releasedAt" IS NULL)`;
      const settings = await db.adminOperationalSettings.findUnique({ where: { id: "default" } });
      const [paid, stuckCount, awaiting, errors, overdueCount, cases] = await Promise.all([
        db.orderAllocation.count({ where: { createdAt: range } }),
        db.payment.count({ where: stuckPayments(asOf, settings?.paymentLagWarnSeconds) }),
        db.payment.count({ where: { status: "AWAITING_CUSTOMER", expiresAt: { gt: asOf } } }),
        db.fulfillmentJob.count({ where: { status: { in: ["FAILED", "NEEDS_REVIEW"] } } }),
        db.fulfillmentJob.count({ where: overdueJobs(asOf, settings?.fulfillmentLagWarnSeconds) }),
        db.supportCase.count({ where: { status: { notIn: ["RESOLVED", "CLOSED"] } } }),
      ]);
      const finance = financeAllowed ? await db.$queryRaw<{
        currency: string; captured: string; allocated: string; unallocated: string;
        refunded: string; chargebackDebits: string; chargebackReversals: string; net: string;
      }[]>`
        SELECT t.currency,
          COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CAPTURE'),0)::text AS captured,
          COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CAPTURE' AND a.id IS NOT NULL),0)::text AS allocated,
          COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CAPTURE' AND a.id IS NULL),0)::text AS unallocated,
          COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='REFUND'),0)::text AS refunded,
          COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CHARGEBACK_DEBIT'),0)::text AS "chargebackDebits",
          COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CHARGEBACK_REVERSAL'),0)::text AS "chargebackReversals",
          SUM(CASE WHEN t.kind IN ('CAPTURE','CHARGEBACK_REVERSAL') THEN t."amountMinor"
                   WHEN t.kind IN ('REFUND','CHARGEBACK_DEBIT') THEN -t."amountMinor" ELSE 0 END)::text AS net
        FROM "PaymentTransaction" t LEFT JOIN "OrderAllocation" a ON a."captureId" = t.id AND a."createdAt" <= ${asOf}
        WHERE t."providerTime" >= ${from} AND t."providerTime" < ${to} AND t."receivedAt" <= ${asOf}
        GROUP BY t.currency ORDER BY t.currency` : undefined;
      const result = { asOf, range: { from, to }, users: block(users, asOf), subscriptions: block(subscriptions ?? null, asOf),
        orders: block({ paid }, asOf), payments: block({ stuck: stuckCount, awaiting }, asOf),
        jobs: block({ errors, overdue: overdueCount }, asOf), support: block({ open: cases }, asOf) };
      return { ...result, ...(finance && { finance: block(finance, asOf) }) };
    }, { isolationLevel: "RepeatableRead" });
    const sources = await health();
    const alerts = [
      ...Object.entries(sources).flatMap(([kind, value]) => value.state === "FRESH" || value.reasonCode === "PANEL_DISABLED" ? [] : [{ kind, reasonCode: value.reasonCode }]),
      ...(data.jobs.data?.overdue ? [{ kind: "jobs", reasonCode: "JOBS_OVERDUE" }] : []),
      ...(data.payments.data?.stuck ? [{ kind: "payments", reasonCode: "PAYMENTS_STUCK" }] : []),
    ];
    return { ...data, ...sources, alerts };
  });
};
