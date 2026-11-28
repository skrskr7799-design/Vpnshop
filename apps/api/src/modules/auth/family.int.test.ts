import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { sha256 } from "../../lib/crypto";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { hashPassword } from "./password";
import { createSession } from "./session.service";
import { verifyAccessToken } from "./jwt";

let app: FastifyInstance;
beforeEach(async () => { await resetDatabase(); app = await buildApp(); });
afterEach(async () => { await app.close(); });
const headers = { origin: env.WEB_ORIGIN };
const access = (token: string) => app.inject({ url: "/api/auth/me", cookies: { vpn_at: token } });

it("returns the login method from the live family and preserves it across refresh", async () => {
  const user = await createUser();
  const old = await createSession(user, {});
  expect((await access(old.accessToken)).json().loginMethod).toBeNull();
  const session = await createSession(user, { loginMethod: "TELEGRAM" });
  expect((await access(session.accessToken)).json().loginMethod).toBe("telegram");
  const refresh = await app.inject({ method: "POST", url: "/api/auth/refresh", headers,
    cookies: { vpn_rt: session.refreshToken } });
  expect(refresh.statusCode).toBe(204);
  const next = refresh.cookies.find(cookie => cookie.name === "vpn_at")!.value;
  expect((await access(next)).json().loginMethod).toBe("telegram");
});

it("isolates devices and rejects JWTs immediately after revoke, revoke others and logout", async () => {
  const user = await createUser();
  const first = await createSession(user, { userAgent: "Fixture device" });
  const second = await createSession(user, {});
  const other = await createSession(await createUser(), {});
  const secondSid = (await verifyAccessToken(second.accessToken))!.sid;
  const cookies = { vpn_at: first.accessToken };
  const list = await app.inject({ url: "/api/auth/sessions", cookies });
  expect(list.json().sessions).toHaveLength(2);
  expect(list.body).not.toMatch(/tokenHash|refreshToken/);
  expect((await app.inject({ method: "DELETE", url: `/api/auth/sessions/${secondSid}`, headers,
    cookies: { vpn_at: other.accessToken } })).statusCode).toBe(404);
  expect((await app.inject({ method: "DELETE", url: `/api/auth/sessions/${secondSid}`, headers, cookies })).statusCode).toBe(204);
  expect((await access(second.accessToken)).statusCode).toBe(401);
  const third = await createSession(user, {});
  expect((await app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", headers, cookies })).statusCode).toBe(204);
  expect((await access(third.accessToken)).statusCode).toBe(401);
  expect((await access(first.accessToken)).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/api/auth/logout", cookies, headers })).statusCode).toBe(204);
  expect((await access(first.accessToken)).statusCode).toBe(401);
  expect((await access(other.accessToken)).statusCode).toBe(200);
});

it("consumes reset once in a race, revokes access and invalidates pending link intents", async () => {
  const user = await prisma.user.create({ data: { email: "reset-family@example.invalid", emailVerifiedAt: new Date() } });
  const { accessToken } = await createSession(user, {});
  const sid = (await verifyAccessToken(accessToken))!.sid;
  const token = randomUUID() + randomUUID();
  await prisma.verificationToken.create({ data: { tokenHash: sha256(token), userId: user.id,
    type: "PASSWORD_RESET", expiresAt: new Date(Date.now() + 60_000) } });
  await prisma.identityProof.create({ data: { familyId: sid, target: "GOOGLE", purpose: "LINK",
    expiresAt: new Date(Date.now() + 60_000) } });
  const responses = await Promise.all([1, 2].map(() => app.inject({
    method: "POST", url: "/api/auth/reset-password", headers, payload: { token, password: "New-test-password-123" },
  })));
  expect(responses.map(r => r.statusCode).sort()).toEqual([204, 400]);
  expect((await access(accessToken)).statusCode).toBe(401);
  expect(await prisma.identityProof.count()).toBe(0);
});

it("blocks staff reset even for an existing valid token and guards the last login method", async () => {
  const staff = await prisma.user.create({ data: { role: "ADMIN", email: "staff@example.invalid", emailVerifiedAt: new Date() } });
  const token = randomUUID() + randomUUID();
  await prisma.verificationToken.create({ data: { userId: staff.id, tokenHash: sha256(token), type: "PASSWORD_RESET",
    expiresAt: new Date(Date.now() + 60_000) } });
  expect((await app.inject({ method: "POST", url: "/api/auth/reset-password", headers,
    payload: { token, password: "New-test-password-123" } })).statusCode).toBe(400);
  const user = await createUser();
  await prisma.authIdentity.create({ data: { userId: user.id, provider: "EMAIL", providerId: user.email!,
    verifiedAt: new Date(), passwordHash: await hashPassword("Existing-password-123") } });
  const cookies = { vpn_at: (await createSession(user, {})).accessToken };
  const proof = await app.inject({ method: "POST", url: "/api/auth/oauth/reauth", headers, cookies,
    payload: { target: "EMAIL", purpose: "UNLINK", method: "EMAIL", password: "Existing-password-123" } });
  expect(proof.statusCode).toBe(403);
  expect((await app.inject({ method: "DELETE", url: "/api/auth/oauth/identities/EMAIL", headers, cookies,
    payload: { confirmationId: randomUUID() } })).json().error.code).toBe("LAST_LOGIN_METHOD");
  expect((await app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", cookies, headers: { origin: "https://other.invalid" } })))
    .toMatchObject({ statusCode: 403 });
});
