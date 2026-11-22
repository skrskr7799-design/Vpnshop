import { ownerSupportRoutes } from "./modules/support/support.routes";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { env, isProd } from "./config/env";
import { AppError } from "./lib/errors";
import { registerErrorHandler } from "./lib/error-handler";
import { authRoutes } from "./modules/auth/auth.routes";
import { commerceRoutes } from "./modules/commerce/commerce.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { oauthRoutes } from "./modules/oauth/oauth.routes";
import { loadProviders } from "./modules/oauth/providers";
import { paymentFixture, paymentWebhookRoutes } from "./modules/payments/payments.routes";
import type { AssignmentPanel } from "./modules/remnawave/remnawave.assignment";
import type { PaymentProviderAdapter } from "./modules/payments/provider";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(options: { payments?: PaymentProviderAdapter; panel?: AssignmentPanel } = {}) {
  const payments = paymentFixture(options.payments);
  const app = Fastify({
    // за reverse proxy: корректный IP клиента для rate limit и аудита
    trustProxy: env.WEB_TRUSTED_PROXIES.length ? env.WEB_TRUSTED_PROXIES : false,
    disableRequestLogging: true,
    logger: {
      level: isProd ? "info" : "debug",
      // секреты не должны попадать в логи
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-fixture-secret']", "res.headers['set-cookie']"],
      transport: isProd ? undefined : { target: "pino-pretty" },
    },
  });

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

      await api.register(healthRoutes);
      await api.register(ownerSupportRoutes);
      await api.register(commerceRoutes, { payments, panel: options.panel });
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(oauthRoutes, { prefix: "/auth/oauth", providers: loadProviders() });
    },
    { prefix: "/api" },
  );

  return app;
}
