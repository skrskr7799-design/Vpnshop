import { checkoutKeySchema, createPaymentSchema, orderParamsSchema, paymentParamsSchema } from "@vpn/shared";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { attemptResult, createAttempt } from "./attempts";
import { acceptWebhook } from "./inbox";
import type { PaymentProviderAdapter } from "./provider";
import { merchantAccount } from "./store";

// Only an explicitly injected fixture can exercise the payment HTTP routes in COM-02.
export function paymentFixture(adapter?: PaymentProviderAdapter) {
  if (adapter && (env.NODE_ENV !== "test" || adapter.account.environment !== "MOCK" ||
      adapter.account.provider !== "PLATEGA")) throw new Error("Only isolated payment fixtures are enabled");
  return adapter;
}

export function paymentOwnerRoutes(app: FastifyInstance, adapter?: PaymentProviderAdapter) {
  app.post("/orders/:id/payments", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = orderParamsSchema.parse(req.params);
    const { channel } = createPaymentSchema.parse(req.body);
    const key = checkoutKeySchema.parse(req.headers["idempotency-key"]);
    if (!adapter) throw new AppError(503, "PAYMENTS_DISABLED");
    const attempt = await createAttempt(await merchantAccount(adapter), adapter, req.auth!.userId, id, channel, key);
    const pending = ["SUBMITTING", "UNKNOWN"].includes(attempt.status);
    return reply.code(pending ? 202 : 201).send(await attemptResult(attempt, true));
  });

  app.get("/orders/:id/payments/:paymentId", async req => {
    const { id, paymentId } = paymentParamsSchema.parse(req.params);
    const payment = await prisma.payment.findFirst({ where: {
      id: paymentId, orderId: id, order: { userId: req.auth!.userId }, accountId: { not: null },
    } });
    if (!payment) throw new AppError(404, "NOT_FOUND");
    const fixture = adapter && await merchantAccount(adapter);
    return attemptResult(payment, !!fixture && fixture.id === payment.accountId);
  });
}

export function paymentWebhookRoutes(app: FastifyInstance, adapter?: PaymentProviderAdapter) {
  app.post<{ Params: { account: string } }>("/webhooks/platega/:account", {
    bodyLimit: 16_384, config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (!adapter || req.params.account !== adapter.account.merchant) throw new AppError(404, "NOT_FOUND");
    const { eventKey, observation } = adapter.verifyWebhook(req.headers, req.body);
    await acceptWebhook(await merchantAccount(adapter), eventKey, observation);
    return reply.code(200).send({ accepted: true });
  });
}
