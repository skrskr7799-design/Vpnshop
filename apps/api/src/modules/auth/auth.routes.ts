import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "@vpn/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";
import { REFRESH_COOKIE } from "./auth.constants";
import {
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
import { revokeSessionFamily, rotateSession } from "./session.service";

const ctxOf = (req: FastifyRequest): AuthContext => ({
  log: req.log,
  ip: req.ip,
  userAgent: req.headers["user-agent"],
});

// Жёсткие лимиты по IP поверх глобального
const limit = (max: number, timeWindow: string) => ({ config: { rateLimit: { max, timeWindow } } });

export async function authRoutes(app: FastifyInstance) {
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
    return { user };
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

  app.get("/me", { preHandler: authenticate }, async (req) => {
    return { user: await getCurrentUser(req.auth!.userId) };
  });
}
