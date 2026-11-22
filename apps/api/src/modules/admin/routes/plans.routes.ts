import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../../../lib/errors";
import { keysetQuery, keysetPage, keysetWhere, newestFirst } from "../../../lib/keyset";
import { prisma } from "../../../lib/prisma";
import { requireAdmin } from "../admin.middleware";

const planParams = z.strictObject({ id: z.uuid() });

export const adminPlansRoutes: FastifyPluginAsync = async (app) => {
  app.get("/plans", { preHandler: requireAdmin("plans:read") }, async req => {
    const { cursor, limit, active } = keysetQuery.extend({ active: z.enum(["true", "false"]).optional() }).parse(req.query);
    const scope = "admin-plans:" + (active ?? "all");
    const rows = await prisma.plan.findMany({ where: {
      isActive: active === undefined ? undefined : active === "true", ...keysetWhere(scope, cursor),
    }, orderBy: newestFirst, take: limit + 1, select: {
      id: true, code: true, name: true, deviceLimit: true, isActive: true, sortOrder: true, revision: true, createdAt: true,
    } });
    return keysetPage(scope, rows, limit, row => row);
  });

  app.get("/plans/:id/versions", { preHandler: requireAdmin("plans:read") }, async req => {
    const { id } = planParams.parse(req.params);
    const { cursor, limit } = keysetQuery.parse(req.query);
    const plan = await prisma.plan.findUnique({ where: { id } });
    if (!plan) throw new AppError(404, "PLAN_NOT_FOUND");
    const scope = "admin-plan-versions:" + id;
    const where = keysetWhere(scope, cursor);
    const rows = await prisma.offerVersion.findMany({
      where: { offer: { planId: id }, OR: where.OR?.map(({ createdAt, id }) => ({ publishedAt: createdAt, id })) },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, planPriceId: true, version: true, name: true, amount: true, currency: true,
        deviceLimit: true, durationMonths: true, publishedAt: true, withdrawnAt: true },
    });
    return { plan, ...keysetPage(scope, rows.map(row => ({ ...row, createdAt: row.publishedAt })), limit, row => row) };
  });

};
