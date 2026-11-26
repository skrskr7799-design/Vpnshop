import {
  emailField,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@vpn/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";
import { z } from "zod";
import { verifyAccessToken } from "./jwt";
import { ACCESS_COOKIE, REFRESH_COOKIE } from "./auth.constants";
import {
  changeTemporaryUserPassword,
  forgotPassword,
  getCurrentUser,
  login,
  register,
  resetPassword,
  verifyEmail,
  type AuthContext,
} from "./auth.service";
import { authenticate } from "./authenticate";
import { clearAuthCookies, setAuthCookies } from "./cookies";
import { listDevices, revokeDevice, revokeOtherDevices, revokeSessionFamily, rotateSession } from "./session.service";

const ctxOf = (req: FastifyRequest): AuthContext => ({
  log: req.log,
  ip: req.ip,
  userAgent: req.headers["user-agent"],
});

// Жёсткие лимиты по IP поверх глобального
const limit = (max: number, timeWindow: string) => ({ config: { rateLimit: { max, timeWindow } } });

export async function authRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
  });
  app.post("/register", limit(5, "1 hour"), async (req, reply) => {
    await register(registerSchema.parse(req.body), ctxOf(req));
    // одинаковый ответ независимо от того, есть ли уже аккаунт
    return reply.code(202).send({ ok: true });
  });

  app.post("/verify-email", limit(20, "1 hour"), async (req, reply) => {
    await verifyEmail(verifyEmailSchema.parse(req.body).token);
    return reply.code(204).send();
  });

  app.post("/login", limit(10, "15 minutes"), async (req, reply) => {
    const { user, ...tokens } = await login(loginSchema.parse(req.body), ctxOf(req));
    setAuthCookies(reply, tokens);
    return { user, sessionId: (await verifyAccessToken(tokens.accessToken))!.sid };
  });

  app.post("/password/change-temporary", limit(10, "15 minutes"), async (req, reply) => {
    const input = z.strictObject({ email: emailField, temporaryPassword: z.string().min(12).max(128),
      password: z.string().min(12).max(128) }).parse(req.body);
    await changeTemporaryUserPassword(input.email, input.temporaryPassword, input.password);
    return reply.code(204).send();
  });

  app.post("/refresh", limit(30, "1 minute"), async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw new AppError(401, "INVALID_SESSION");
    try {
      setAuthCookies(reply, await rotateSession(token, ctxOf(req)));
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof AppError && err.code === "INVALID_SESSION") {
        clearAuthCookies(reply);
        return reply.code(401).send({ error: { code: err.code } });
      }
      throw err;
    }
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) await revokeSessionFamily(token);
    const access = req.cookies[ACCESS_COOKIE];
    const claims = access ? await verifyAccessToken(access) : null;
    if (claims) await revokeDevice(claims.userId, claims.sid);
    clearAuthCookies(reply);
    return reply.code(204).send();
  });

  app.post("/forgot-password", limit(5, "1 hour"), async (req, reply) => {
    await forgotPassword(forgotPasswordSchema.parse(req.body), ctxOf(req));
    return reply.code(202).send({ ok: true });
  });

  app.post("/reset-password", limit(10, "1 hour"), async (req, reply) => {
    await resetPassword(resetPasswordSchema.parse(req.body));
    return reply.code(204).send();
  });

  app.get("/sessions", { preHandler: authenticate }, async req => ({ sessions: await listDevices(req.auth!) }));
  app.delete("/sessions/:id", { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await revokeDevice(req.auth!.userId, id, req.auth!);
    if (id === req.auth!.sid) clearAuthCookies(reply);
    return reply.code(204).send();
  });
  app.post("/sessions/revoke-others", { preHandler: authenticate }, async (req, reply) => {
    await revokeOtherDevices(req.auth!);
    return reply.code(204).send();
  });

  app.get("/me", { preHandler: authenticate }, async (req) => {
    return { user: await getCurrentUser(req.auth!.userId), sessionId: req.auth!.sid };
  });
}
