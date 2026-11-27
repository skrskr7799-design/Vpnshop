import {
  emailField,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@vpn/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { emailAvailable } from "../../config/env";
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
  requestEmailVerification,
  setEmailPassword,
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
    const registrationReference = await register(registerSchema.parse(req.body), ctxOf(req));
    // одинаковый ответ независимо от того, есть ли уже аккаунт
    return reply.code(202).send({ ok: true, emailAvailable, registrationReference });
  });

  app.post("/verify-email", limit(20, "1 hour"), async (req, reply) => {
    const access = req.cookies[ACCESS_COOKIE];
    await verifyEmail(verifyEmailSchema.parse(req.body).token, access ? await verifyAccessToken(access) ?? undefined : undefined);
    return reply.code(204).send();
  });

  app.post("/resend-verification", limit(5, "1 hour"), async (req, reply) => {
    await requestEmailVerification(forgotPasswordSchema.parse(req.body).email, ctxOf(req));
    return reply.code(202).send({ ok: true, emailAvailable });
  });

  app.post("/email/verify", { ...limit(8, "1 hour"), preHandler: authenticate }, async (req, reply) => {
    const { email, confirmationId } = z.strictObject({ email: emailField, confirmationId: z.uuid() }).parse(req.body);
    await requestEmailVerification(email, ctxOf(req), { claims: req.auth!, id: confirmationId });
    return reply.code(202).send({ ok: true });
  });

  app.post("/email/password", { ...limit(8, "1 hour"), preHandler: authenticate }, async (req, reply) => {
    const { confirmationId, password } = z.strictObject({ confirmationId: z.uuid(), password: z.string().min(12).max(128) }).parse(req.body);
    await setEmailPassword(req.auth!, confirmationId, password);
    clearAuthCookies(reply);
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
    return reply.code(202).send({ ok: true, emailAvailable });
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
