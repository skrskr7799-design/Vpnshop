import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { isProd } from "../../config/env";

// Состояние входа живёт в подписанной httpOnly-куке на время похода к провайдеру.
// Кука одноразовая: callback сразу её стирает.
const FLOW_COOKIE_PATH = "/api/auth/oauth";
const FLOW_TTL_SECONDS = 10 * 60;

const flowSchema = z.object({
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  nonce: z.string().optional(),
  returnTo: z.string().optional(),
  intent: z.union([z.object({ mode: z.literal("login") }), z.object({ mode: z.literal("link"), userId: z.string() })]),
});
export type OAuthFlow = z.infer<typeof flowSchema>;

export const flowCookieName = (providerId: string): string => `vpn_oauth_${providerId}`;

const cookieOptions = { httpOnly: true, secure: isProd, sameSite: "lax" as const, path: FLOW_COOKIE_PATH };

export function setFlowCookie(reply: FastifyReply, providerId: string, flow: OAuthFlow): void {
  reply.setCookie(flowCookieName(providerId), Buffer.from(JSON.stringify(flow)).toString("base64url"), {
    ...cookieOptions,
    signed: true,
    maxAge: FLOW_TTL_SECONDS,
  });
}

export function readFlowCookie(req: FastifyRequest, providerId: string): OAuthFlow | null {
  const raw = req.cookies[flowCookieName(providerId)];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid) return null;
  
  try {
    return flowSchema.parse(JSON.parse(Buffer.from(unsigned.value, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export function clearFlowCookie(reply: FastifyReply, providerId: string): void {
  reply.clearCookie(flowCookieName(providerId), cookieOptions);
}
