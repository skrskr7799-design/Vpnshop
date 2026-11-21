import type { FastifyReply, FastifyRequest } from "fastify";
import { isProd } from "../../config/env";
import { AppError } from "../../lib/errors";
import { resolveAdminSession, type AdminContext } from "./auth/admin-session.service";
import { can, type Permission } from "./admin.permissions";

declare module "fastify" {
  interface FastifyRequest {
    admin: AdminContext | null;
  }
}

export const ADMIN_COOKIE = "vpn_admin";

const cookieBase = { httpOnly: true, secure: isProd, sameSite: "strict" as const, path: "/" };

export const setAdminCookie = (reply: FastifyReply, token: string, expiresAt: Date) =>
  reply.setCookie(ADMIN_COOKIE, token, { ...cookieBase, expires: expiresAt });

export const clearAdminCookie = (reply: FastifyReply) => reply.clearCookie(ADMIN_COOKIE, cookieBase);

// preHandler: требует сессию админа и (необязательно) конкретное право
export function requireAdmin(permission?: Permission) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = req.cookies[ADMIN_COOKIE];
    const admin = token ? await resolveAdminSession(token) : null;
    if (!admin) throw new AppError(401, "UNAUTHENTICATED");
    if (permission && !can(admin.role, permission)) throw new AppError(403, "FORBIDDEN");
    req.admin = admin;
  };
}

// Для роутов после requireAdmin
export function adminOf(req: FastifyRequest): AdminContext {
  if (!req.admin) throw new AppError(401, "UNAUTHENTICATED");
  return req.admin;
}
