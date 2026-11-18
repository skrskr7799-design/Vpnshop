import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { env, isProd } from "./config/env";
import { healthRoutes } from "./modules/health/health.routes";

export async function buildApp() {
  const app = Fastify({
    // за reverse proxy: корректный IP клиента для rate limit и аудита
    trustProxy: true,
    logger: {
      level: isProd ? "info" : "debug",
      // секреты не должны попадать в логи
      redact: ["req.headers.authorization", "req.headers.cookie"],
      transport: isProd ? undefined : { target: "pino-pretty" },
    },
  });

  await app.register(helmet);
  await app.register(cors, { origin: env.WEB_ORIGIN, credentials: true });
  await app.register(cookie, { secret: env.COOKIE_SECRET });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });

  await app.register(healthRoutes);

  return app;
}
