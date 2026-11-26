import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { sha256 } from "../../lib/crypto";
import { supportCommands } from "../support/support.service";
import { commandFingerprint, type Commands } from "./commands";
import { staffCommands } from "./staff";
import { storeCommands } from "./store-commands";
import type { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { adminLogin, confirmEnrollment, createStaffAccount, startEnrollment } from "./auth/admin-auth.service";
import type { AdminRole } from "./admin.permissions";
import { hashPassword } from "../auth/password";
import { currentCode } from "./auth/totp";
import { buildAdminApp } from "./admin-app";

// Общие помощники интеграционных тестов админки
export const PASSWORD = "admin-password-123";
export const ctx = { ip: "10.0.0.5", userAgent: "vitest" };

export const buildTestAdminApp = (opts: { allowedCidrs?: string[] } = {}) =>
  buildAdminApp({ panel: { getMetadata: async () => ({ version: "3.4.9" }) }, logger: false, ...opts });

export type EnrolledAdmin = { userId: string; email: string; username: string; secret: string; recoveryCodes: string[]; sessionToken: string };

// Fixture identities have the same shape as deployed accounts.
export const fixtureUsername = (email: string) => "fixture-" + email.toLowerCase().split("@", 1)[0];
export async function createAdminUser({ email, password, role }: { email: string; password: string; role: AdminRole }) {
  if (password.length < 12) throw new Error("Staff passwords require 12 characters");
  const user = await createStaffAccount(prisma, { username: fixtureUsername(email), contactEmail: email,
    passwordHash: await hashPassword(password), role });
  return { userId: user.id, username: fixtureUsername(email) };
}

export async function createEnrolledAdmin(email: string, role: AdminRole = "ADMIN"): Promise<EnrolledAdmin> {
  const { userId, username } = await createAdminUser({ email, password: PASSWORD, role });
  const started = await adminLogin({ username, password: PASSWORD }, ctx);
  if (started.step !== "enroll_2fa") throw new Error("Expected enrollment fixture");
  const { secret } = await startEnrollment(started.stageToken);
  const confirmed = await confirmEnrollment(started.stageToken, currentCode(secret), ctx);
  return { userId, email, username, secret, recoveryCodes: confirmed.recoveryCodes, sessionToken: confirmed.sessionToken };
}

// HTTP-запрос от имени админа: кука сессии и Origin, как у настоящего фронта
export function as(app: FastifyInstance, sessionToken: string) {
  const headers = { origin: env.ADMIN_ORIGIN };
  const cookies = { vpn_admin: sessionToken };
  return {
    command: async (operation: string, targetId: string, version: string | number, command: object, options?: { key?: string; expired?: boolean; reason?: string }) => {
      const payload = await prepareCommand(sessionToken, operation, targetId, version, command, options);
      return app.inject({ method: "POST", url: `/api/commands/${operation}/${encodeURIComponent(targetId)}`, cookies,
        headers: { ...headers, "idempotency-key": options?.key ?? randomUUID() }, payload });
    },
    get: (url: string) => app.inject({ method: "GET", url, cookies }),
    post: (url: string, payload?: unknown) => app.inject({ method: "POST", url, cookies, headers, payload: payload as object }),
    put: (url: string, payload?: unknown) => app.inject({ method: "PUT", url, cookies, headers, payload: payload as object }),
    patch: (url: string, payload?: unknown) => app.inject({ method: "PATCH", url, cookies, headers, payload: payload as object }),
    delete: (url: string) => app.inject({ method: "DELETE", url, cookies, headers }),
  };
}

// Domain regression tests seed a short-lived proof so they can execute several
// commercial commands in one TOTP period. Separate protocol tests use the HTTP step-up.
export async function prepareCommand(sessionToken: string, operation: string, targetId: string,
  expectedVersion: string | number, data: object, options: { expired?: boolean; reason?: string } = {}) {
  const session = await prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: sha256(sessionToken) },
    select: { id: true, user: { select: { staffCredential: true } } } });
  const entries: Commands = { ...staffCommands, ...storeCommands, ...supportCommands };
  const entry = entries[operation]!;
  const reason = options.reason ?? "Integration test command";
  const body = { expectedVersion: String(expectedVersion), reason, command: entry.parse(data) };
  const proof = await prisma.adminConfirmation.create({ data: {
    sessionId: session.id, expiresAt: new Date(Date.now() + (options.expired ? -1000 : 60_000)),
    version: session.user.staffCredential!.version, fingerprint: commandFingerprint(operation, entry.permission, targetId, body),
  } });
  return { ...body, confirmationId: proof.id };
}
