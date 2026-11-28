import type { AuthProvider } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";
import { ACCESS_COOKIE } from "./auth.constants";
import { requireLiveFamily, touchFamily } from "./session.service";
import { verifyAccessToken, type AuthClaims } from "./jwt";

declare module "fastify" {
  interface FastifyRequest {
    auth: (AuthClaims & { loginMethod?: AuthProvider | null }) | null;
  }
}

// preHandler для защищённых роутов: проверяет access-токен из httpOnly-куки.
export async function authenticate(req: FastifyRequest): Promise<void> {
  const token = req.cookies[ACCESS_COOKIE];
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) throw new AppError(401, "UNAUTHENTICATED");
  const expected = req.headers["x-mzt-session"];
  if (expected !== undefined && expected !== claims.sid) throw new AppError(401, "SESSION_CHANGED");
  const family = await requireLiveFamily(claims);
  await touchFamily(family);
  req.auth = { ...claims, role: family.user.role, loginMethod: family.loginMethod };
}
