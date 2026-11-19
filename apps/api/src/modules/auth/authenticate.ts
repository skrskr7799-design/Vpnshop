import type { FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors";
import { ACCESS_COOKIE } from "./auth.constants";
import { verifyAccessToken, type AuthClaims } from "./jwt";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthClaims | null;
  }
}

// preHandler для защищённых роутов: проверяет access-токен из httpOnly-куки.
export async function authenticate(req: FastifyRequest): Promise<void> {
  const token = req.cookies[ACCESS_COOKIE];
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) throw new AppError(401, "UNAUTHENTICATED");
  req.auth = claims;
}
