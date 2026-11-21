import { createPlanSchema, updatePlanSchema, upsertPriceSchema } from "@vpn/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { isUniqueViolation } from "../../../lib/db-errors";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { dbNow, lockPlanForEdit, publishOffer, withdrawOffer } from "../../commerce/offers";
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
        prices: {
          orderBy: [{ durationMonths: "asc" }, { currency: "asc" }],
          include: { versions: { orderBy: { version: "desc" } } },
        },
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
      const before = await lockPlanForEdit(tx, id);
      const after = await tx.plan.update({ where: { id }, data: patch });
      const versions: string[] = [];
      if (before.name !== after.name || before.deviceLimit !== after.deviceLimit) {
        const publishedPrices = await tx.planPrice.findMany({
          where: { planId: id, isActive: true, versions: { some: { withdrawnAt: null } } },
          orderBy: { id: "asc" },
        });
        const now = await dbNow(tx);
        for (const price of publishedPrices) versions.push((await publishOffer(tx, after, price, now)).id);
      }
      // В журнал идут только изменившиеся поля: было → стало
      const changes = Object.fromEntries(
        Object.keys(patch).map((key) => [key, { from: before[key as keyof typeof before], to: after[key as keyof typeof after] }]),
      );
      await writeAudit(tx, { ...auditCtx(req), action: "plan.update", entity: "plan", entityId: id, data: { ...changes, ...(versions.length ? { offerVersionIds: versions } : {}) } as never });
      return after;
    });
    return { plan };
  });

  // Удалять можно только тариф без заказов, иначе его можно лишь отключить (isActive=false)
  app.delete("/plans/:id", { preHandler: requireAdmin("plans:write") }, async (req, reply) => {
    const { id } = planParams.parse(req.params);
    await prisma.$transaction(async (tx) => {
      const plan = await lockPlanForEdit(tx, id);
      if (await tx.order.count({ where: { planId: id } })) throw new AppError(409, "PLAN_HAS_ORDERS");
      if (await tx.offerVersion.count({ where: { offer: { planId: id } } })) {
        throw new AppError(409, "PLAN_HAS_OFFER_HISTORY");
      }
      await tx.plan.delete({ where: { id } });
      await writeAudit(tx, { ...auditCtx(req), action: "plan.delete", entity: "plan", entityId: id, data: { code: plan.code } });
    });
    return reply.code(204).send();
  });

  // PUT prepares a draft when inactive, or publishes the terms as an immutable version.
  app.put("/plans/:id/prices", { preHandler: requireAdmin("plans:write") }, async (req) => {
    const { id } = planParams.parse(req.params);
    const input = upsertPriceSchema.parse(req.body);
    const price = await prisma.$transaction(async (tx) => {
      const plan = await lockPlanForEdit(tx, id);
      const key = { planId_durationMonths_currency: { planId: id, durationMonths: input.durationMonths, currency: input.currency } };
      const before = await tx.planPrice.findUnique({ where: key });
      const saved = await tx.planPrice.upsert({
        where: key,
        create: { planId: id, ...input },
        update: { amount: input.amount, isActive: input.isActive },
      });
      const now = await dbNow(tx);
      const published = saved.isActive ? await publishOffer(tx, plan, saved, now) : null;
      if (!published) await withdrawOffer(tx, saved.id, now);
      await writeAudit(tx, {
        ...auditCtx(req),
        action: "plan.price.upsert",
        entity: "plan",
        entityId: id,
        data: { durationMonths: input.durationMonths, currency: input.currency, from: before?.amount ?? null, to: input.amount, isActive: input.isActive, offerVersionId: published?.id ?? null },
      });
      return { ...saved, offerVersionId: published?.id ?? null };
    });
    return { price };
  });

  app.delete("/plans/:id/prices/:priceId", { preHandler: requireAdmin("plans:write") }, async (req, reply) => {
    const { id, priceId } = priceParams.parse(req.params);
    await prisma.$transaction(async (tx) => {
      await lockPlanForEdit(tx, id);
      const price = await tx.planPrice.findFirst({
        where: { id: priceId, planId: id }, include: { _count: { select: { versions: true } } },
      });
      if (!price) throw new AppError(404, "PRICE_NOT_FOUND");
      if (price._count.versions > 0) {
        if (!price.isActive) throw new AppError(404, "PRICE_NOT_FOUND");
        await withdrawOffer(tx, price.id, await dbNow(tx));
        await tx.planPrice.update({ where: { id: priceId }, data: { isActive: false } });
      } else {
        await tx.planPrice.delete({ where: { id: priceId } });
      }
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
