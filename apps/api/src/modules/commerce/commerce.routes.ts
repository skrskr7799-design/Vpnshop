import { catalogQuerySchema, checkoutBodySchema, checkoutKeySchema, orderParamsSchema } from "@vpn/shared";
import type { FastifyPluginAsync } from "fastify";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { authenticate } from "../auth/authenticate";
import { getCurrentUser } from "../auth/auth.service";
import { dbNow, toOffer } from "./offers";
import { checkout, ownerOrder, snapshot } from "./orders";

export const commerceRoutes: FastifyPluginAsync = async app => {
  app.get("/plans", async (req, reply) => {
    const { currency } = catalogQuerySchema.parse(req.query);
    const [versions, asOf] = await prisma.$transaction(async db => [
      await db.offerVersion.findMany({
        where: { currency, withdrawnAt: null, offer: { isActive: true, plan: { isActive: true } } },
        include: { offer: { select: { planId: true } } },
        orderBy: [{ offer: { plan: { sortOrder: "asc" } } }, { offer: { plan: { code: "asc" } } },
          { durationMonths: "asc" }, { currency: "asc" }, { id: "asc" }],
      }),
      await dbNow(db),
    ], { isolationLevel: "RepeatableRead" });
    reply.header("Cache-Control", "no-store");
    return { offers: versions.map(version => toOffer(version, version.offer.planId)), asOf: asOf.toISOString() };
  });

  app.register(async orders => {
    orders.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "private, no-store"); });
    orders.addHook("preHandler", async req => {
      await authenticate(req);
      await getCurrentUser(req.auth!.userId);
    });

    orders.post("/orders", async (req, reply) => {
      const { offerVersionId } = checkoutBodySchema.parse(req.body);
      const key = checkoutKeySchema.parse(req.headers["idempotency-key"]);
      const order = await checkout(req.auth!.userId, key, offerVersionId);
      return reply.code(201).send({ orderId: order.id, snapshot: snapshot(order), expiresAt: order.expiresAt.toISOString() });
    });

    orders.get("/orders/:id", async req => {
      const { id } = orderParamsSchema.parse(req.params);
      const order = await ownerOrder(req.auth!.userId, id);
      if (!order) throw new AppError(404, "NOT_FOUND");
      return {
        id: order.id, createdAt: order.createdAt.toISOString(), expiresAt: order.expiresAt.toISOString(),
        snapshot: snapshot(order), orderStatus: order.status, allowedChannels: [], canStartPayment: false,
      };
    });
  });
};
