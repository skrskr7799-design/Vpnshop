import {
  adminEnrollConfirmSchema,
  adminEnrollStartSchema,
  adminLoginSchema,
  adminVerifySchema,
} from "@vpn/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { resolveAdminSession } from "../auth/admin-session.service";
import {
  adminLogin,
  confirmEnrollment,
  logoutAdmin,
  startEnrollment,
  verifySecondFactor,
} from "../auth/admin-auth.service";
import { ADMIN_COOKIE, adminOf, clearAdminCookie, requireAdmin, setAdminCookie } from "../admin.middleware";
import { ROLE_PERMISSIONS } from "../admin.permissions";

const limit = (max: number, timeWindow: string) => ({ config: { rateLimit: { max, timeWindow } } });
const metaOf = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers["user-agent"] });

export const adminAuthRoutes: FastifyPluginAsync = async (app) => {
  // Шаг 1: пароль. Отдаёт короткий токен этапа, но не сессию.
  app.post("/auth/login", limit(10, "15 minutes"), async (req) =>
    adminLogin(adminLoginSchema.parse(req.body), metaOf(req)),
  );

  // Первый вход: выдать секрет и ссылку для приложения-аутентификатора
  app.post("/auth/2fa/enroll/start", limit(10, "15 minutes"), async (req) =>
    startEnrollment(adminEnrollStartSchema.parse(req.body).stageToken),
  );

  app.post("/auth/2fa/enroll/confirm", limit(10, "15 minutes"), async (req, reply) => {
    const { stageToken, code } = adminEnrollConfirmSchema.parse(req.body);
    const result = await confirmEnrollment(stageToken, code, metaOf(req));
    setAdminCookie(reply, result.sessionToken, result.expiresAt);
    // Резервные коды показываются один раз
    return { recoveryCodes: result.recoveryCodes };
  });

  // Шаг 2: код из приложения или резервный код. Здесь выдаётся сессия.
  app.post("/auth/2fa/verify", limit(10, "15 minutes"), async (req, reply) => {
    const { stageToken, code, recoveryCode } = adminVerifySchema.parse(req.body);
    const result = await verifySecondFactor(stageToken, { code, recoveryCode }, metaOf(req));
    setAdminCookie(reply, result.sessionToken, result.expiresAt);
    return { recoveryCodesLeft: result.recoveryCodesLeft ?? null };
  });

  app.post("/auth/logout", async (req, reply) => {
    const token = req.cookies[ADMIN_COOKIE];
    if (token) {
      const admin = await resolveAdminSession(token);
      await logoutAdmin(token, admin?.userId ?? null, req.ip);
    }
    clearAdminCookie(reply);
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: requireAdmin() }, async (req) => {
    const admin = adminOf(req);
    return { user: { id: admin.userId, email: admin.email, role: admin.role }, permissions: ROLE_PERMISSIONS[admin.role] };
  });
};
