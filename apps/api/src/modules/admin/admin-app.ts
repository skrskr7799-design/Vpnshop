import { addHttpTelemetry, serviceLogger, telemetryRequestId, startMetrics } from "../../lib/telemetry";
import { healthRoutes, setDrain } from "../health/health.routes";
import { staffSupportRoutes } from "../support/support.routes";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import ipaddr from "ipaddr.js";
import Fastify from "fastify";
import { env, isProd } from "../../config/env";
import { AppError } from "../../lib/errors";
import { registerErrorHandler } from "../../lib/error-handler";
import { registerCommandProtocol } from "./commands";
import { staffCommands, staffRoutes } from "./staff";
import { createIpGuard } from "./admin.ip-guard";
import { explicitPublicAdminAccess } from "../../config/proxy";
import { adminAuditRoutes } from "./routes/audit.routes";
import { adminAuthRoutes } from "./routes/auth.routes";
import { adminDashboardRoutes, type DashboardDeps } from "./routes/dashboard.routes";
import { adminReadRoutes, adminJobsReadRoutes } from "./routes/read.routes";
import { registerStoreRoutes } from "./routes/store.routes";
import { storeCommands } from "./store-commands";
import { supportCommands } from "../support/support.service";
import { adminPlansRoutes } from "./routes/plans.routes";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type AdminAppOptions = DashboardDeps & {
  /** Для тестов: переопределяет ADMIN_ALLOWED_CIDRS */
  allowedCidrs?: string[];
  /** Для тестов: выключить логирование */
  logger?: boolean;
};

// Отдельный сервер админки: своя кука, свой origin, свой порт. Публичный API этих маршрутов не содержит вообще.
export async function buildAdminApp(options: AdminAppOptions) {
  const cidrs = options.allowedCidrs ?? env.ADMIN_ALLOWED_CIDRS;
  const origin = new URL(env.ADMIN_ORIGIN);
  if (isProd && (!cidrs.length || origin.protocol !== "https:" || origin.origin !== env.ADMIN_ORIGIN ||
      origin.hostname === new URL(env.WEB_ORIGIN).hostname)) {
    throw new Error("Admin requires a dedicated HTTPS origin and a nonempty production CIDR allowlist");
  }
  for (const entry of env.ADMIN_TRUSTED_PROXIES) {
    if (!ipaddr.isValid(entry)) {
      const [, prefix] = ipaddr.parseCIDR(entry);
      if (prefix === 0) throw new Error("An unrestricted admin proxy range is forbidden");
    }
  }
  const app = Fastify({
    disableRequestLogging: true,
    // Не доверяем X-Forwarded-For по умолчанию: иначе IP-фильтр обходится подделкой заголовка
    trustProxy: env.ADMIN_TRUSTED_PROXIES.length ? env.ADMIN_TRUSTED_PROXIES : false,
    logger: options.logger === false ? false : serviceLogger("admin-api"),
    genReqId: telemetryRequestId,
  });
  const metrics = addHttpTelemetry(app);
  app.addHook("onListen", async () => startMetrics(metrics));
  registerErrorHandler(app);
  setDrain(app);

  await app.register(helmet);
  await app.register(cors, { origin: env.ADMIN_ORIGIN, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  app.decorateRequest("admin", null);

  const publicInternet = options.allowedCidrs === undefined && explicitPublicAdminAccess(env.ADMIN_ACCESS_MODE, cidrs);
  const ipAllowed = createIpGuard(publicInternet ? [] : cidrs);

  await app.register(healthRoutes);

  // Чужому адресу админка отвечает как несуществующая
  app.addHook("onRequest", async (req) => {
    if (req.routeOptions.url === "/health" || req.routeOptions.url === "/ready") return;
    if (!ipAllowed(req.ip)) throw new AppError(404, "NOT_FOUND");
  });
  // CSRF: изменяющие запросы только с нашего фронта (вдобавок к SameSite=Strict)
  app.addHook("onRequest", async (req) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (req.headers.origin !== env.ADMIN_ORIGIN) throw new AppError(403, "BAD_ORIGIN");
  });
  // Ответы админки не кэшируются нигде
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  await app.register(
    async (api) => {
      const execute = registerCommandProtocol(api, { ...staffCommands, ...storeCommands, ...supportCommands });
      registerStoreRoutes(api, execute);
      await api.register(staffRoutes);
      await api.register(healthRoutes);
      await api.register(adminAuthRoutes);
      await api.register(adminDashboardRoutes, { panel: options.panel });
      await api.register(adminPlansRoutes);
      await api.register(adminReadRoutes);
      await api.register(adminJobsReadRoutes);
      await api.register(adminAuditRoutes);
      await api.register(staffSupportRoutes);
    },
    { prefix: "/api" },
  );

  return app;
}
