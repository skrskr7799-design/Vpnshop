import type { FastifyPluginAsync } from "fastify";
import { prisma } from "../../../lib/prisma";
import type { RemnawaveClient } from "../../remnawave/remnawave.client";
import { requireAdmin } from "../admin.middleware";

export type DashboardDeps = { panel: Pick<RemnawaveClient, "getMetadata"> };

const DAY = 24 * 3_600_000;
const PANEL_TTL_MS = 30_000;
const PANEL_TIMEOUT_MS = 5_000;

const ORDER_STATUSES = ["PENDING", "PAID", "FULFILLED", "EXPIRED", "CANCELED", "REFUNDED"] as const;
const JOB_STATUSES = ["PENDING", "RUNNING", "DONE", "FAILED"] as const;

const zeroed = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export const adminDashboardRoutes: FastifyPluginAsync<DashboardDeps> = async (app, { panel }) => {
  // Состояние панели: кэшируем, чтобы обновления дашборда не нагружали Remnawave
  let cached: { at: number; value: { ok: boolean; version: string | null } } | null = null;
  async function panelHealth() {
    if (cached && Date.now() - cached.at < PANEL_TTL_MS) return cached.value;
    let value: { ok: boolean; version: string | null };
    try {
      const meta = await Promise.race([
        panel.getMetadata(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), PANEL_TIMEOUT_MS)),
      ]);
      value = { ok: true, version: meta.version };
    } catch {
      value = { ok: false, version: null };
    }
    cached = { at: Date.now(), value };
    return value;
  }

  app.get("/dashboard", { preHandler: requireAdmin("dashboard:read") }, async () => {
    const now = Date.now();
    const paid = { status: { in: ["PAID", "FULFILLED"] as ("PAID" | "FULFILLED")[] } };
    const [usersTotal, usersWeek, ordersByStatus, revenue30d, revenueAll, jobsByStatus, health] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: new Date(now - 7 * DAY) } } }),
      prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.order.groupBy({ by: ["currency"], where: { ...paid, paidAt: { gte: new Date(now - 30 * DAY) } }, _sum: { amount: true }, _count: { _all: true } }),
      prisma.order.groupBy({ by: ["currency"], where: paid, _sum: { amount: true }, _count: { _all: true } }),
      prisma.fulfillmentJob.groupBy({ by: ["status"], where: { assignmentId: null }, _count: { _all: true } }),
      panelHealth(),
    ]);

    const orders = zeroed(ORDER_STATUSES);
    for (const row of ordersByStatus) orders[row.status] = row._count._all;
    const jobs = zeroed(JOB_STATUSES);
    for (const status of JOB_STATUSES) jobs[status] = jobsByStatus.find(row => row.status === status)?._count._all ?? 0;

    const money = (rows: typeof revenueAll) =>
      rows.map((r) => ({ currency: r.currency, amount: r._sum.amount ?? 0, orders: r._count._all }));

    return {
      users: { total: usersTotal, last7d: usersWeek },
      orders,
      revenue: { last30d: money(revenue30d), allTime: money(revenueAll) },
      jobs,
      panel: health,
      generatedAt: new Date().toISOString(),
    };
  });
};
