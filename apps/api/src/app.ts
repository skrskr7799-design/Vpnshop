import { addHttpTelemetry, serviceLogger, telemetryRequestId, startMetrics } from "./lib/telemetry";
import { ownerSupportRoutes } from "./modules/support/support.routes";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { paymentRestriction, publicConfig } from "./config/product";
import { env } from "./config/env";
import { AppError } from "./lib/errors";
import { registerErrorHandler } from "./lib/error-handler";
import { authRoutes } from "./modules/auth/auth.routes";
import { commerceRoutes } from "./modules/commerce/commerce.routes";
import { healthRoutes, setDrain } from "./modules/health/health.routes";
import { ownerNoticeRoutes } from "./modules/notifications/customer-notices";
import { oauthRoutes } from "./modules/oauth/oauth.routes";
import { loadProviders } from "./modules/oauth/providers";
import { paymentFixture, paymentWebhookRoutes } from "./modules/payments/payments.routes";
import type { AssignmentPanel } from "./modules/remnawave/remnawave.assignment";
import type { PaymentProviderAdapter } from "./modules/payments/provider";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(options: { payments?: PaymentProviderAdapter; panel?: AssignmentPanel } = {}) {
  const payments = paymentFixture(options.payments);
  if (env.PAYMENTS_ENABLED && env.NODE_ENV !== "test") throw new Error("Payments require an admitted provider contract");
  const providers = loadProviders();
  const panel = env.REMNAWAVE_ENABLED === false ? undefined : options.panel;
  const restriction = () => paymentRestriction(env, { provider: !!payments, panel: !!panel });
  const configuration = () => publicConfig(env, {
    registration: env.REGISTRATION_ENABLED && !env.MAINTENANCE_MODE,
    support: env.SUPPORT_ENABLED && !env.MAINTENANCE_MODE,
    payments: !restriction() && !!payments, maintenance: env.MAINTENANCE_MODE,
    google: providers.has("google"), telegram: providers.has("telegram"),
  });
  const app = Fastify({
    // за reverse proxy: корректный IP клиента для rate limit и аудита
    trustProxy: env.WEB_TRUSTED_PROXIES.length ? env.WEB_TRUSTED_PROXIES : false,
    disableRequestLogging: true,
    logger: serviceLogger("public-api"),
    genReqId: telemetryRequestId,
  });

  const metrics = addHttpTelemetry(app);
  app.addHook("onListen", async () => startMetrics(metrics));
  setDrain(app);
  await app.register(helmet);
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

  app.decorateRequest("auth", null);

  registerErrorHandler(app);

  // Всё, что вызывает браузер с куками, живёт под /api.
  await app.register(async hook => { paymentWebhookRoutes(hook, payments); });
  await app.register(
    async (api) => {
      // CSRF: на изменяющих запросах Origin обязан совпасть с нашим фронтом.
      // Вместе с SameSite=Lax и приёмом только application/json этого достаточно.
      api.addHook("onRequest", async (req) => {
        if (SAFE_METHODS.has(req.method)) return;
        if (req.headers.origin !== env.WEB_ORIGIN) throw new AppError(403, "BAD_ORIGIN");
      });

      api.get("/config", (_req, reply) => reply.header("Cache-Control", "no-store").send(configuration()));
      await api.register(healthRoutes);
      await api.register(ownerSupportRoutes);
      await api.register(ownerNoticeRoutes);
      await api.register(commerceRoutes, { payments, panel, restriction });
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(oauthRoutes, { prefix: "/auth/oauth", providers });
    },
    { prefix: "/api" },
  );

  return app;
}
