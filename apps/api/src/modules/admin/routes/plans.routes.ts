import { createPlanSchema, updatePlanSchema, upsertPriceSchema } from "@vpn/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { isUniqueViolation } from "../../../lib/db-errors";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { writeAudit } from "../admin.audit";
import { adminOf, requireAdmin } from "../admin.middleware";

const planParams = z.object({ id: z.uuid() });
const priceParams = z.object({ id: z.uuid(), priceId: z.uuid() });

const auditCtx = (req: FastifyRequest) => ({ actorId: adminOf(req).userId, ip: req.ip });

export const adminPlansRoutes: FastifyPluginAsync = async (app) => {
  app.get("/plans", { preHandler: requireAdmin("plans:read") }, async () => {
    const plans = await prisma.plan.findMany({
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      include: {
        prices: { orderBy: [{ durationMonths: "asc" }, { currency: "asc" }] },
        _count: { select: { orders: true } },
      },
    });
    return { plans };
  });

  app.post("/plans", { preHandler: requireAdmin("plans:write") }, async (req, reply) => {
    const input = createPlanSchema.parse(req.body);
    try {
      const plan = await prisma.$transaction(async (tx) => {
        const created = await tx.plan.create({ data: input });
        await writeAudit(tx, { ...auditCtx(req), action: "plan.create", entity: "plan", entityId: created.id, data: input });
        return created;
      });
      return reply.code(201).send({ plan });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(409, "CODE_TAKEN");
      throw err;
    }
  });

  app.patch("/plans/:id", { preHandler: requireAdmin("plans:write") }, async (req) => {
    const { id } = planParams.parse(req.params);
    const patch = updatePlanSchema.parse(req.body);
    const plan = await prisma.$transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { id } });
      if (!before) throw new AppError(404, "PLAN_NOT_FOUND");
      const after = await tx.plan.update({ where: { id }, data: patch });
      // В журнал идут только изменившиеся поля: было → стало
      const changes = Object.fromEntries(
        Object.keys(patch).map((key) => [key, { from: before[key as keyof typeof before], to: after[key as keyof typeof after] }]),
      );
      await writeAudit(tx, { ...auditCtx(req), action: "plan.update", entity: "plan", entityId: id, data: changes as never });
      return after;
    });
    return { plan };
  });

  // Удалять можно только тариф без заказов, иначе его можно лишь отключить (isActive=false)
  app.delete("/plans/:id", { preHandler: requireAdmin("plans:write") }, async (req, reply) => {
    const { id } = planParams.parse(req.params);
    await prisma.$transaction(async (tx) => {
      const plan = await tx.plan.findUnique({ where: { id }, include: { _count: { select: { orders: true } } } });
      if (!plan) throw new AppError(404, "PLAN_NOT_FOUND");
      if (plan._count.orders > 0) throw new AppError(409, "PLAN_HAS_ORDERS");
      await tx.plan.delete({ where: { id } });
      await writeAudit(tx, { ...auditCtx(req), action: "plan.delete", entity: "plan", entityId: id, data: { code: plan.code } });
    });
    return reply.code(204).send();
  });

  // Цена за срок в валюте: создаёт или обновляет. Старые заказы не меняются (в заказе снимок цены).
  app.put("/plans/:id/prices", { preHandler: requireAdmin("plans:write") }, async (req) => {
    const { id } = planParams.parse(req.params);
    const input = upsertPriceSchema.parse(req.body);
    const price = await prisma.$transaction(async (tx) => {
      if (!(await tx.plan.findUnique({ where: { id }, select: { id: true } }))) throw new AppError(404, "PLAN_NOT_FOUND");
      const key = { planId_durationMonths_currency: { planId: id, durationMonths: input.durationMonths, currency: input.currency } };
      const before = await tx.planPrice.findUnique({ where: key });
      const saved = await tx.planPrice.upsert({
        where: key,
        create: { planId: id, ...input },
        update: { amount: input.amount, isActive: input.isActive },
      });
      await writeAudit(tx, {
        ...auditCtx(req),
        action: "plan.price.upsert",
        entity: "plan",
        entityId: id,
        data: { durationMonths: input.durationMonths, currency: input.currency, from: before?.amount ?? null, to: input.amount, isActive: input.isActive },
      });
      return saved;
    });
    return { price };
  });

  app.delete("/plans/:id/prices/:priceId", { preHandler: requireAdmin("plans:write") }, async (req, reply) => {
    const { id, priceId } = priceParams.parse(req.params);
    await prisma.$transaction(async (tx) => {
      const price = await tx.planPrice.findFirst({ where: { id: priceId, planId: id } });
      if (!price) throw new AppError(404, "PRICE_NOT_FOUND");
      await tx.planPrice.delete({ where: { id: priceId } });
      await writeAudit(tx, {
        ...auditCtx(req),
        action: "plan.price.delete",
        entity: "plan",
        entityId: id,
        data: { durationMonths: price.durationMonths, currency: price.currency, amount: price.amount },
      });
    });
    return reply.code(204).send();
  });
};
