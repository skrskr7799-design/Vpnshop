import { randomBytes, randomUUID } from "node:crypto";
import { staffUsernameSchema } from "@vpn/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { sha256 } from "../../lib/crypto";
import { hashPassword } from "../auth/password";
import { isUniqueViolation } from "../../lib/db-errors";
import { adminLogin, changeTemporaryStaffPassword, confirmEnrollment, startEnrollment } from "./auth/admin-auth.service";
import { adoptLegacyOwner, bootstrapOwner, recoverOwner } from "./auth/local-admin";
import { synchronizeAdminPolicy } from "./auth/policy";
import { currentCode } from "./auth/totp";
import { as, buildTestAdminApp, createAdminUser, createEnrolledAdmin, ctx, PASSWORD } from "./admin.test-helpers";

const temp = "initial-staff-fixture-23";
const permanent = "replacement-fixture-34";
const previousPolicy = env.ADMIN_2FA_POLICY;
const previousMode = env.ADMIN_ACCESS_MODE;
const previousMailKey = env.MAIL_QUEUE_KEY;
let adminApp: FastifyInstance;
let publicApp: FastifyInstance;
beforeEach(async () => {
  await resetDatabase();
  adminApp = await buildTestAdminApp();
  publicApp = await buildApp();
});
afterEach(async () => {
  env.ADMIN_2FA_POLICY = previousPolicy;
  env.ADMIN_ACCESS_MODE = previousMode;
  env.MAIL_QUEUE_KEY = previousMailKey;
  await Promise.all([adminApp.close(), publicApp.close()]);
});
const local = { username: "first-owner", password: PASSWORD, correlationId: randomUUID() };
const publicPost = (path: string, payload: object) => publicApp.inject({ method: "POST", url: "/api/auth/" + path,
  headers: { origin: env.WEB_ORIGIN }, payload });
const direct = (session: string, operation: string, target: string, version: string | number,
  command: object, confirmationId?: string) => adminApp.inject({
  method: "POST", url: `/api/commands/${operation}/${encodeURIComponent(target)}`,
  headers: { origin: env.ADMIN_ORIGIN, "idempotency-key": randomUUID() }, cookies: { vpn_admin: session },
  payload: { expectedVersion: version, command, ...(confirmationId && { confirmationId }) },
});
async function passwordSession(username: string, password = PASSWORD) {
  const response = await adminApp.inject({ method: "POST", url: "/api/auth/login", headers: { origin: env.ADMIN_ORIGIN },
    payload: { username, password } });
  expect(response.json()).toEqual({ step: "authenticated" });
  return response.cookies.find(cookie => cookie.name === "vpn_admin")!.value;
}

it("normalizes only unambiguous ASCII usernames and serializes concurrent bootstrap", async () => {
  expect(staffUsernameSchema.parse("FiRsT-OWNER")).toBe("first-owner");
  for (const invalid of [" ab", "ab", "ab c", "øwner", "owner\n", " A..." ]) expect(staffUsernameSchema.safeParse(invalid).success).toBe(false);
  const requests = await Promise.allSettled([bootstrapOwner(local), bootstrapOwner({ ...local, username: "second-owner" })]);
  expect(requests.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(await prisma.user.count({ where: { role: "OWNER" } })).toBe(1);
  await expect(bootstrapOwner(local)).rejects.toMatchObject({ code: "STAFF_ALREADY_INITIALIZED" });
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "admin.owner.bootstrap" } });
  expect(audit).toMatchObject({ actorId: null, correlationId: local.correlationId });
  expect(JSON.stringify(audit)).not.toContain(local.password);
  await expect(prisma.staffCredential.create({ data: { username: "INVALID", passwordHash: "fixture", user: { create: { role: "ADMIN" } } } })).rejects.toBeTruthy();
});

it("adopts a selected legacy admin once, preserving credentials and invalidating sessions", async () => {
  const admin = await createEnrolledAdmin("legacy@example.invalid");
  const hash = (await prisma.staffCredential.findUniqueOrThrow({ where: { userId: admin.userId } })).passwordHash;
  await expect(bootstrapOwner(local)).rejects.toMatchObject({ code: "STAFF_ALREADY_INITIALIZED" });
  const req = { username: admin.username, correlationId: randomUUID(), incident: "TEST-1234" };
  await expect(adoptLegacyOwner(req)).resolves.toMatchObject({ id: admin.userId, role: "OWNER" });
  await expect(adoptLegacyOwner(req)).rejects.toMatchObject({ code: "OWNER_ALREADY_EXISTS" });
  expect((await prisma.staffCredential.findUniqueOrThrow({ where: { userId: admin.userId } })).passwordHash).toBe(hash);
  expect(await prisma.adminTotp.count()).toBe(1);
  expect(await prisma.adminRecoveryCode.count()).toBe(10);
  expect((await as(adminApp, admin.sessionToken).get("/api/me")).statusCode).toBe(401);
  await expect(recoverOwner({ ...req, password: permanent, resetTotp: true, restoreStatus: false })).resolves.toMatchObject({ id: admin.userId });
  expect(await prisma.adminTotp.count()).toBe(0);
  expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(permanent);
});

it("enforces OWNER grants on direct commands, consumes temporary staff password once and rejects case aliases", async () => {
  const owner = await createEnrolledAdmin("owner@example.invalid", "OWNER");
  const admin = await createEnrolledAdmin("staff-admin@example.invalid");
  const support = await createEnrolledAdmin("support@example.invalid", "SUPPORT");
  const own = as(adminApp, owner.sessionToken);
  const staff = { username: "New.Staff", role: "ADMIN", temporaryPassword: temp };
  const customer = { email: "customer@example.invalid" };
  for (const actor of [admin, support]) {
    const api = as(adminApp, actor.sessionToken);
    expect((await api.command("staff.create", "new", 0, staff)).statusCode).toBe(403);
    expect((await api.command("user.create", "new", 0, customer)).statusCode).toBe(403);
    expect((await api.post("/api/auth/step-up", { operation: "staff.create", permission: "staff:write", targetId: "new",
      expectedVersion: 0, command: staff, reason: "Provision fixture staff", password: PASSWORD })).statusCode).toBe(403);
  }
  expect((await own.command("staff.create", "new", 0, staff)).statusCode).toBe(200);
  expect((await own.command("staff.create", "new", 0, { ...staff, username: "nEW.staff" })).json().error.code).toBe("STAFF_USERNAME_IN_USE");
  const login = await adminLogin({ username: "new.staff", password: temp }, ctx);
  if (login.step !== "change_password") throw new Error("Expected restricted first login");
  expect(await prisma.adminSession.count({ where: { user: { staffCredential: { is: { username: "new.staff" } } } } })).toBe(0);
  const changed = await Promise.allSettled([changeTemporaryStaffPassword(login.stageToken, permanent, ctx),
    changeTemporaryStaffPassword(login.stageToken, permanent, ctx)]);
  expect(changed.filter(result => result.status === "fulfilled")).toHaveLength(1);
  await expect(adminLogin({ username: "new.staff", password: temp }, ctx)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  await expect(adminLogin({ username: "new.staff", password: permanent }, ctx)).resolves.toMatchObject({ step: "enroll_2fa" });
  expect(JSON.stringify(await prisma.adminCommand.findMany())).not.toContain(temp);
  expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(temp);
});

it("reserves email without a credential and approves only the independently verified claim", async () => {
  const owner = await createEnrolledAdmin("owner@example.invalid", "OWNER");
  const admin = await createEnrolledAdmin("admin@example.invalid");
  const existing = await createUser({ email: "occupied@example.invalid" });
  const input = { email: "new-user@example.invalid" };
  const create = (email: string) => direct(owner.sessionToken, "user.create", "new", 0, { email });
  expect((await create(existing.email!)).json().error.code).toBe("USER_EMAIL_IN_USE");
  const reservations = await Promise.all([create(input.email), create(input.email)]);
  expect(reservations.map(reply => reply.statusCode)).toEqual([200, 200]);
  expect(reservations[0]!.json().result).toEqual(reservations[1]!.json().result);
  expect(await prisma.pendingRegistration.count({ where: { email: input.email, passwordHash: null } })).toBe(1);
  const attacker = await publicPost("register", { email: input.email, password: temp });
  const claimant = await publicPost("register", { email: input.email, password: permanent });
  const reference = claimant.json().registrationReference as string;
  const request = await prisma.pendingRegistration.findFirstOrThrow({ where: { approvalHash: sha256(reference) } });
  expect(request.tokenHash).toBeNull();
  expect(await prisma.notificationOutbox.count()).toBe(0);
  expect(await prisma.user.findUnique({ where: { email: input.email } })).toBeNull();
  const login = await publicPost("login", { email: input.email, password: permanent });
  expect(login.statusCode).toBe(401);
  expect(login.cookies).toHaveLength(0);
  const activate = (registrationReference: string) => direct(admin.sessionToken, "user.registration.activate",
    request.id, request.createdAt.toISOString(), { registrationReference });
  expect((await activate(attacker.json().registrationReference)).json().error.code).toBe("REGISTRATION_REFERENCE_MISMATCH");
  const replies = await Promise.all([activate(reference), activate(reference)]);
  expect(replies.map(result => result.statusCode).sort()).toEqual([200, 404]);
  expect(await prisma.pendingRegistration.count({ where: { email: input.email } })).toBe(0);
  const user = await prisma.user.findUniqueOrThrow({ where: { email: input.email }, include: { identities: true } });
  expect(user).toMatchObject({ emailVerifiedAt: null, activationRequired: false, manualActivatedAt: expect.any(Date) });
  expect(user.identities[0]).toMatchObject({ passwordHash: request.passwordHash, temporaryPasswordExpiresAt: null });
  expect((await publicPost("login", { email: input.email, password: temp })).statusCode).toBe(401);
  expect((await publicPost("login", { email: input.email, password: permanent })).statusCode).toBe(200);
  expect(await prisma.order.count()).toBe(0);
  expect(await prisma.paymentTransaction.count()).toBe(0);
  expect(await prisma.subscription.count()).toBe(0);
  expect(await prisma.panelBinding.count()).toBe(0);
  expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(reference);
});

it("cancels a mismatched request and preserves the original self-registration password", async () => {
  const admin = await createEnrolledAdmin("operator@example.invalid");
  const email = "pending-registration@example.invalid";
  const register = () => publicPost("register", { email, password: permanent });
  const wrong = (await register()).json().registrationReference;
  const right = (await register()).json().registrationReference;
  const rows = (await as(adminApp, admin.sessionToken).get("/api/users/registrations")).json();
  expect(rows.items).toHaveLength(2);
  expect(JSON.stringify(rows)).not.toContain("approvalHash");
  expect(JSON.stringify(rows)).not.toContain("passwordHash");
  const current = await prisma.pendingRegistration.findFirstOrThrow({ where: { approvalHash: sha256(right) } });
  const other = await prisma.pendingRegistration.findFirstOrThrow({ where: { approvalHash: sha256(wrong) } });
  expect((await direct(admin.sessionToken, "user.registration.cancel", other.id, other.createdAt.toISOString(), {})).statusCode).toBe(200);
  expect((await direct(admin.sessionToken, "user.registration.activate", current.id, current.createdAt.toISOString(),
    { registrationReference: right })).statusCode).toBe(200);
  expect((await publicPost("login", { email, password: permanent })).statusCode).toBe(200);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { identities: true } });
  expect(user.emailVerifiedAt).toBeNull();
  expect(user.identities[0]).toMatchObject({ passwordHash: current.passwordHash, temporaryPasswordExpiresAt: null });
  const blocked = await prisma.user.update({ where: { id: user.id }, data: { status: "BLOCKED", activationRequired: true } });
  expect((await direct(admin.sessionToken, "user.activate", blocked.id, blocked.updatedAt.toISOString(), {})).json().error.code)
    .toBe("ACCOUNT_BLOCKED");
});

it("requires step-up for a permanent password change and invalidates customer sessions and reset proofs", async () => {
  const admin = await createEnrolledAdmin("operator@example.invalid");
  const support = await createEnrolledAdmin("support@example.invalid", "SUPPORT");
  const email = "access@example.invalid";
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date(),
    identities: { create: { provider: "EMAIL", providerId: email, passwordHash: await hashPassword(temp) } } } });
  const token = randomUUID();
  const reset = await prisma.verificationToken.create({ data: { userId: user.id, email, type: "PASSWORD_RESET",
    expiresAt: new Date(Date.now() + 60_000), tokenHash: sha256(token) } });
  const previousLogin = await publicPost("login", { email, password: temp });
  expect(previousLogin.statusCode).toBe(200);
  const version = user.updatedAt.toISOString();
  expect((await direct(support.sessionToken, "user.password.set", user.id, version, { password: permanent })).statusCode).toBe(403);
  const noProof = await direct(admin.sessionToken, "user.password.set", user.id, version, { password: permanent });
  expect(noProof.json().error.code).toBe("STEP_UP_REQUIRED");
  await prisma.adminTotp.update({ where: { userId: admin.userId }, data: { lastUsedStep: null } });
  const proof = await as(adminApp, admin.sessionToken).post("/api/auth/step-up", { operation: "user.password.set",
    permission: "users:write", targetId: user.id, expectedVersion: version, command: { password: permanent },
    password: PASSWORD, code: currentCode(admin.secret) });
  expect(proof.statusCode).toBe(200);
  expect((await direct(admin.sessionToken, "user.password.set", user.id, version, { password: permanent },
    proof.json().confirmationId)).statusCode).toBe(200);
  expect(await prisma.sessionFamily.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  expect((await prisma.verificationToken.findUniqueOrThrow({ where: { id: reset.id } })).usedAt).toBeTruthy();
  expect((await publicPost("reset-password", { token, password: temp })).json().error.code).toBe("INVALID_TOKEN");
  expect((await publicPost("login", { email, password: temp })).statusCode).toBe(401);
  expect((await publicPost("login", { email, password: permanent })).statusCode).toBe(200);
  expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(permanent);
  const oauth = await prisma.user.create({ data: { identities: { create: { provider: "GOOGLE", providerId: randomUUID() } } } });
  expect((await as(adminApp, admin.sessionToken).command("user.password.set", oauth.id, oauth.updatedAt.toISOString(),
    { password: permanent })).json().error.code).toBe("PASSWORD_NOT_CONFIGURED");
});

it("queues the same password recovery email with a shared budget and never creates an OAuth-only password", async () => {
  const admin = await createEnrolledAdmin("operator@example.invalid");
  const support = await createEnrolledAdmin("support@example.invalid", "SUPPORT");
  const email = "recovery@example.invalid";
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date(),
    identities: { create: [
      { provider: "EMAIL", providerId: email, passwordHash: await hashPassword(temp) },
      { provider: "GOOGLE", providerId: randomUUID() },
    ] } } });
  const api = as(adminApp, admin.sessionToken);
  const version = user.updatedAt.toISOString();
  env.MAIL_QUEUE_KEY = undefined;
  expect((await api.command("user.password.send_reset", user.id, version, {})).json().error.code).toBe("EMAIL_UNAVAILABLE");
  env.MAIL_QUEUE_KEY = randomBytes(32).toString("base64");
  expect((await direct(support.sessionToken, "user.password.send_reset", user.id, version, {})).statusCode).toBe(403);
  for (let index = 0; index < 3; index++) {
    const response = await api.command("user.password.send_reset", user.id, version, {});
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toEqual({ id: user.id, resetQueued: true });
  }
  expect((await api.command("user.password.send_reset", user.id, version, {})).statusCode).toBe(429);
  expect(await prisma.notificationOutbox.count()).toBe(3);
  expect(await prisma.verificationToken.count({ where: { userId: user.id, type: "PASSWORD_RESET", usedAt: null } })).toBe(1);
  const oauth = await prisma.user.create({ data: { email: "oauth@example.invalid", emailVerifiedAt: new Date(),
    identities: { create: { provider: "TELEGRAM", providerId: randomUUID() } } } });
  expect((await api.command("user.password.send_reset", oauth.id, oauth.updatedAt.toISOString(), {})).json().error.code)
    .toBe("PASSWORD_NOT_CONFIGURED");
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: null } });
  const unverified = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  expect((await api.command("user.password.send_reset", user.id, unverified.updatedAt.toISOString(), {})).json().error.code)
    .toBe("PASSWORD_RESET_UNAVAILABLE");
});

it("distinguishes all policies and requires current factors for session and step-up", async () => {
  const admin = await createAdminUser({ email: "fresh@example.invalid", password: PASSWORD, role: "OWNER" });
  const enrolled = await createEnrolledAdmin("enrolled@example.invalid", "ADMIN");
  const first = as(adminApp, enrolled.sessionToken);
  const old = await adminLogin({ username: admin.username, password: PASSWORD }, ctx);
  expect(old.step).toBe("enroll_2fa");
  env.ADMIN_2FA_POLICY = "disabled";
  env.ADMIN_ACCESS_MODE = "public";
  await synchronizeAdminPolicy();
  expect((await first.get("/api/me")).statusCode).toBe(401);
  const session = await passwordSession(admin.username.toUpperCase());
  const api = as(adminApp, session);
  expect((await api.get("/api/me")).json().security).toMatchObject({ policy: "disabled", requiresTotp: false });
  const proof = await api.post("/api/auth/step-up", { operation: "staff.create", permission: "staff:write", targetId: "new",
    expectedVersion: "0", reason: "Provision test staff", command: { username: "planned", temporaryPassword: temp, role: "SUPPORT" },
    password: PASSWORD });
  expect(proof.statusCode).toBe(200);
  expect(await prisma.adminTotp.count()).toBe(1);
  env.ADMIN_2FA_POLICY = "optional";
  await synchronizeAdminPolicy();
  expect((await api.get("/api/me")).statusCode).toBe(401);
  await expect(adminLogin({ username: enrolled.username, password: PASSWORD }, ctx)).resolves.toMatchObject({ step: "verify_2fa" });
  const plain = as(adminApp, await passwordSession(admin.username));
  const request = await plain.command("staff.self.totp.enroll", admin.userId, 1, {});
  expect(request.statusCode).toBe(200);
  const staged = request.json().stageToken;
  const setup = await startEnrollment(staged);
  const activated = await confirmEnrollment(staged, currentCode(setup.secret), ctx);
  expect((await plain.get("/api/me")).statusCode).toBe(401);
  const verified = as(adminApp, activated.sessionToken);
  expect((await verified.get("/api/me")).json().security).toMatchObject({ requiresTotp: true });
  expect((await verified.command("staff.self.totp.disable", admin.userId, 1, {})).statusCode).toBe(200);
  expect((await verified.get("/api/me")).statusCode).toBe(401);
  env.ADMIN_2FA_POLICY = "disabled";
  await synchronizeAdminPolicy();
  expect((await api.get("/api/me")).statusCode).toBe(401);
});

it("revokes other staff sessions while preserving the current session", async () => {
  env.ADMIN_2FA_POLICY = "optional";
  const owner = await createAdminUser({ email: "session@example.invalid", password: PASSWORD, role: "OWNER" });
  const current = as(adminApp, await passwordSession(owner.username));
  const extra = as(adminApp, await passwordSession(owner.username));
  expect((await current.post("/api/auth/sessions/revoke-others")).statusCode).toBe(204);
  expect((await extra.get("/api/me")).statusCode).toBe(401);
  expect((await current.get("/api/me")).statusCode).toBe(200);
});

it("rejects an invitation after its issuing OWNER has been demoted", async () => {
  const issuer = await createEnrolledAdmin("issuer@example.invalid", "OWNER");
  const owner = await createEnrolledAdmin("other@example.invalid", "OWNER");
  const mail = "invite@example.invalid";
  const invited = await as(adminApp, issuer.sessionToken).command("staff.invite", mail, 0, { email: mail, role: "SUPPORT" });
  expect(invited.statusCode).toBe(200);
  const change = await as(adminApp, owner.sessionToken).command("staff.role", issuer.userId, 1, { role: "ADMIN" });
  expect(change.statusCode).toBe(200);
  const reply = await adminApp.inject({ method: "POST", url: "/api/auth/invitations/accept", headers: { origin: env.ADMIN_ORIGIN },
    payload: { token: invited.json().invitationToken, username: "would-be-staff", password: temp } });
  expect(reply.json().error.code).toBe("INVITE_INVALID");
  expect(await prisma.staffCredential.count()).toBe(2);
});

it("linearizes mutually deactivating owners", async () => {
  const alice = await createEnrolledAdmin("alice@example.invalid", "OWNER");
  const bob = await createEnrolledAdmin("bob@example.invalid", "OWNER");
  const responses = await Promise.all([
    as(adminApp, alice.sessionToken).command("staff.status", bob.userId, 1, { status: "DEACTIVATED" }),
    as(adminApp, bob.sessionToken).command("staff.status", alice.userId, 1, { status: "DEACTIVATED" }),
  ]);
  const outcomes = responses.map(reply => [reply.statusCode, reply.statusCode === 200 ? "ok" : reply.json().error?.code]);
  expect(outcomes.filter(([status]) => status === 200), JSON.stringify(outcomes)).toHaveLength(1);
  expect(await prisma.user.count({ where: { role: "OWNER", status: "ACTIVE" } })).toBe(1);
  const duplicate = await prisma.staffCredential.create({ data: { username: alice.username, passwordHash: "fixture",
    user: { create: { role: "OWNER" } } } }).catch(error => error);
  expect(isUniqueViolation(duplicate)).toBe(true);
});
