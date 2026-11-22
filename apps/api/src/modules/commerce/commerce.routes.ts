import { catalogQuerySchema, checkoutBodySchema, checkoutKeySchema, orderParamsSchema } from "@vpn/shared";
import type { FastifyPluginAsync } from "fastify";
import { AppError } from "../../lib/errors";
import { keysetQuery } from "../../lib/keyset";
import { listOrders, listPayments, listPeriods, orderProjection, subscriptionOverview } from "../account/projections";
import { requireLiveFamily } from "../auth/session.service";
import { prisma } from "../../lib/prisma";
import { authenticate } from "../auth/authenticate";
import { paymentOwnerRoutes } from "../payments/payments.routes";
import type { PaymentProviderAdapter } from "../payments/provider";
import { getCurrentUser } from "../auth/auth.service";
import { subscriptionLink } from "../fulfillment/subscription-access";
import type { AssignmentPanel } from "../remnawave/remnawave.assignment";
import { dbNow, toOffer } from "./offers";
import { checkout, ownerOrder, snapshot } from "./orders";

export const commerceRoutes: FastifyPluginAsync<{ payments?: PaymentProviderAdapter; panel?: AssignmentPanel }> = async (app, { payments, panel }) => {
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
    orders.addHook("onRequest", async (_req, reply) => { reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer"); });
    orders.addHook("preHandler", async req => {
      await authenticate(req);
      await getCurrentUser(req.auth!.userId);
    });

    paymentOwnerRoutes(orders, payments);

    orders.post("/me/subscription/access", {
      bodyLimit: 1024, config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    }, async (req, reply) => {
      if (req.body !== undefined && (typeof req.body !== "object" || req.body === null ||
          Array.isArray(req.body) || Object.keys(req.body).length)) throw new AppError(400, "VALIDATION_ERROR");
      reply.header("Referrer-Policy", "no-referrer");
      const link = await subscriptionLink(req.auth!.userId, panel);
      await requireLiveFamily(req.auth!);
      return link;
    });

    orders.post("/orders", async (req, reply) => {
      const { offerVersionId } = checkoutBodySchema.parse(req.body);
      const key = checkoutKeySchema.parse(req.headers["idempotency-key"]);
      const order = await checkout(req.auth!.userId, key, offerVersionId);
      return reply.code(201).send({ orderId: order.id, snapshot: snapshot(order), expiresAt: order.expiresAt.toISOString() });
    });

    orders.get("/me/subscription", req => subscriptionOverview(req.auth!.userId));
    orders.get("/me/subscription/periods", req => {
      const { limit, cursor } = keysetQuery.parse(req.query);
      return listPeriods(req.auth!.userId, limit, cursor);
    });
    orders.get("/orders", req => {
      const { limit, cursor } = keysetQuery.parse(req.query);
      return listOrders(req.auth!.userId, limit, cursor);
    });
    orders.get("/orders/:id/payments", req => {
      const { id } = orderParamsSchema.parse(req.params);
      const { limit, cursor } = keysetQuery.parse(req.query);
      return listPayments(req.auth!.userId, id, limit, cursor);
    });

    orders.get("/orders/:id", async req => {
      const { id } = orderParamsSchema.parse(req.params);
      const order = await ownerOrder(req.auth!.userId, id);
      if (!order) throw new AppError(404, "NOT_FOUND");
      const now = await dbNow(prisma);
      const open = !!payments && order.status === "PENDING" && order.expiresAt > now &&
        order.currency === "RUB" && order.offerVersionId !== null;
      const activeAttempt = open && await prisma.payment.findFirst({
        where: { orderId: id, OR: [
          { status: { notIn: ["FAILED", "EXPIRED", "CANCELED"] } }, { externalId: { not: null } },
        ] }, select: { id: true },
      });
      return {
        ...await orderProjection(req.auth!.userId, id, now), allowedChannels: open ? payments.channels : [], canStartPayment: open && !activeAttempt,
      };
    });
  });
};
