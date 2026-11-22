import type { FastifyReply, FastifyRequest } from "fastify";
import { isProd } from "../../config/env";

export const FLOW_TTL_MS = 10 * 60_000;
export const flowCookieName = (providerId: string): string => `vpn_oauth_${providerId}`;
const cookieOptions = { httpOnly: true, secure: isProd, sameSite: "lax" as const, path: "/api/auth/oauth" };

export function setFlowCookie(reply: FastifyReply, providerId: string, browser: string): void {
  reply.setCookie(flowCookieName(providerId), browser, { ...cookieOptions, signed: true, maxAge: FLOW_TTL_MS / 1000 });
}

export function readFlowCookie(req: FastifyRequest, providerId: string): string | null {
  const raw = req.cookies[flowCookieName(providerId)];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

export function clearFlowCookie(reply: FastifyReply, providerId: string): void {
  reply.clearCookie(flowCookieName(providerId), cookieOptions);
}
