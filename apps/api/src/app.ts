import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env, isProd } from "./config/env";
import { AppError } from "./lib/errors";
import { authRoutes } from "./modules/auth/auth.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { oauthRoutes } from "./modules/oauth/oauth.routes";
import { loadProviders } from "./modules/oauth/providers";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp() {
  const app = Fastify({
    // за reverse proxy: корректный IP клиента для rate limit и аудита
    trustProxy: true,
    logger: {
      level: isProd ? "info" : "debug",
      // секреты не должны попадать в логи
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
      transport: isProd ? undefined : { target: "pino-pretty" },
    },
  });

  await app.register(helmet);
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

  app.decorateRequest("auth", null);

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    // штатные ошибки Fastify и плагинов: 415, 429 и т.п.
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: (error as { code?: string }).code ?? "BAD_REQUEST" } });
    }
    req.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });

  // Всё, что вызывает браузер с куками, живёт под /api.
  // Вебхуки платёжек потом подключим вне этого префикса: у них своя проверка (подпись).
  await app.register(
    async (api) => {
      // CSRF: на изменяющих запросах Origin обязан совпасть с нашим фронтом.
      // Вместе с SameSite=Lax и приёмом только application/json этого достаточно.
      api.addHook("onRequest", async (req) => {
        if (SAFE_METHODS.has(req.method)) return;
        if (req.headers.origin !== env.WEB_ORIGIN) throw new AppError(403, "BAD_ORIGIN");
      });

      await api.register(healthRoutes);
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(oauthRoutes, { prefix: "/auth/oauth", providers: loadProviders() });
    },
    { prefix: "/api" },
  );

  return app;
}
