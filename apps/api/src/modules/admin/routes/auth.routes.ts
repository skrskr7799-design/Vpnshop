import { z } from "zod";
import { env } from "../../../config/env";
import {
  adminEnrollConfirmSchema,
  adminEnrollStartSchema,
  adminLoginSchema,
  adminVerifySchema,
} from "@vpn/shared";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { resolveAdminSession } from "../auth/admin-session.service";
import {
  adminLogin,
  changeTemporaryStaffPassword,
  type LoginResult,
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
  function sendLogin(result: LoginResult, reply: FastifyReply) {
    if (result.step !== "authenticated") return result;
    setAdminCookie(reply, result.sessionToken, result.expiresAt);
    return { step: result.step };
  }
  app.post("/auth/login", limit(10, "15 minutes"), async (req, reply) =>
    sendLogin(await adminLogin(adminLoginSchema.parse(req.body), metaOf(req)), reply));

  app.post("/auth/password/change-temporary", limit(10, "15 minutes"), async (req, reply) => {
    const input = adminEnrollStartSchema.extend({ password: z.string().min(12).max(128) }).strict().parse(req.body);
    return sendLogin(await changeTemporaryStaffPassword(input.stageToken, input.password, metaOf(req)), reply);
  });

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
    return { user: { id: admin.userId, email: admin.email, username: admin.username, role: admin.role },
      security: { policy: env.ADMIN_2FA_POLICY, requiresTotp: admin.requiresTotp, enrolled: admin.enrolled, version: admin.credentialVersion }, permissions: ROLE_PERMISSIONS[admin.role] };
  });
};
