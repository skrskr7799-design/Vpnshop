import type { FastifyReply } from "fastify";
import { isProd } from "../../config/env";
import {
  ACCESS_COOKIE,
  ACCESS_TTL_SECONDS,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TTL_MS,
} from "./auth.constants";

const base = { httpOnly: true, secure: isProd, sameSite: "lax" as const };

export function setAuthCookies(reply: FastifyReply, tokens: { accessToken: string; refreshToken: string }) {
  reply.setCookie(ACCESS_COOKIE, tokens.accessToken, { ...base, path: "/", maxAge: ACCESS_TTL_SECONDS });
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    maxAge: Math.floor(REFRESH_TTL_MS / 1000),
  });
}

export function clearAuthCookies(reply: FastifyReply) {
  reply.clearCookie(ACCESS_COOKIE, { ...base, path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
}
