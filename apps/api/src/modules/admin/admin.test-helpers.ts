import type { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { adminLogin, confirmEnrollment, createAdminUser, startEnrollment } from "./auth/admin-auth.service";
import { currentCode } from "./auth/totp";
import { buildAdminApp } from "./admin-app";

// Общие помощники интеграционных тестов админки
export const PASSWORD = "admin-password-123";
export const ctx = { ip: "10.0.0.5", userAgent: "vitest" };

export const buildTestAdminApp = (opts: { allowedCidrs?: string[] } = {}) =>
  buildAdminApp({ panel: { getMetadata: async () => ({ version: "3.4.9" }) }, logger: false, ...opts });

export type EnrolledAdmin = { userId: string; email: string; secret: string; recoveryCodes: string[]; sessionToken: string };

// Создаёт админа и проводит его через первый вход с подключением 2FA (на уровне сервисов)
export async function createEnrolledAdmin(email: string, role: "ADMIN" | "SUPPORT" = "ADMIN"): Promise<EnrolledAdmin> {
  const { userId } = await createAdminUser({ email, password: PASSWORD, role });
  const { stageToken } = await adminLogin({ email, password: PASSWORD }, ctx);
  const { secret } = await startEnrollment(stageToken);
  const confirmed = await confirmEnrollment(stageToken, currentCode(secret), ctx);
  return { userId, email, secret, recoveryCodes: confirmed.recoveryCodes, sessionToken: confirmed.sessionToken };
}

// HTTP-запрос от имени админа: кука сессии и Origin, как у настоящего фронта
export function as(app: FastifyInstance, sessionToken: string) {
  const headers = { origin: env.ADMIN_ORIGIN };
  const cookies = { vpn_admin: sessionToken };
  return {
    get: (url: string) => app.inject({ method: "GET", url, cookies }),
    post: (url: string, payload?: unknown) => app.inject({ method: "POST", url, cookies, headers, payload: payload as object }),
    put: (url: string, payload?: unknown) => app.inject({ method: "PUT", url, cookies, headers, payload: payload as object }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url, cookies, headers, payload: payload as object }),
    delete: (url: string) => app.inject({ method: "DELETE", url, cookies, headers }),
  };
}
