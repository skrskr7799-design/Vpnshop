import { randomUUID } from "node:crypto";
import { staffUsernameSchema } from "@vpn/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
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
  await Promise.all([adminApp.close(), publicApp.close()]);
});
const local = { username: "first-owner", password: PASSWORD, correlationId: randomUUID() };
const publicPost = (path: string, payload: object) => publicApp.inject({ method: "POST", url: "/api/auth/" + path,
  headers: { origin: env.WEB_ORIGIN }, payload });
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
  const customer = { email: "customer@example.invalid", active: true, temporaryPassword: temp };
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

it("activates only eligible customers, without proving email, charging or provisioning", async () => {
  const owner = await createEnrolledAdmin("owner@example.invalid", "OWNER");
  const admin = await createEnrolledAdmin("admin@example.invalid");
  const existing = await createUser({ email: "occupied@example.invalid" });
  const own = as(adminApp, owner.sessionToken);
  const operator = as(adminApp, admin.sessionToken);
  const input = { email: "new-user@example.invalid", temporaryPassword: temp, active: false };
  expect((await own.command("user.create", "new", 0, { ...input, email: existing.email })).json().error.code).toBe("USER_EMAIL_IN_USE");
  const created = await own.command("user.create", "new", 0, input);
  expect(created.statusCode).toBe(200);
  const id = created.json().result.id;
  const pending = await prisma.user.findUniqueOrThrow({ where: { id } });
  expect(pending).toMatchObject({ emailVerifiedAt: null, activationRequired: true, status: "ACTIVE" });
  const credentials = { email: input.email, temporaryPassword: temp, password: permanent };
  const temporaryLogin = await publicPost("login", { email: input.email, password: temp });
  expect(temporaryLogin.json().error.code).toBe("TEMPORARY_PASSWORD");
  expect(temporaryLogin.cookies).toHaveLength(0);
  await prisma.user.update({ where: { id }, data: { status: "BLOCKED" } });
  expect((await publicPost("password/change-temporary", credentials)).statusCode).toBe(403);
  expect((await operator.command("user.activate", id, pending.updatedAt.toISOString(), {})).json().error.code).toBe("ACCOUNT_BLOCKED");
  const restored = await prisma.user.update({ where: { id }, data: { status: "ACTIVE" } });
  expect((await Promise.all([publicPost("password/change-temporary", credentials), publicPost("password/change-temporary", credentials)]))
    .map(reply => reply.statusCode).sort()).toEqual([204, 401]);
  const pendingLogin = await publicPost("login", { email: input.email, password: permanent });
  expect(pendingLogin.json().error.code).toBe("ACTIVATION_PENDING");
  expect(pendingLogin.cookies).toHaveLength(0);
  expect(await prisma.sessionFamily.count({ where: { userId: id } })).toBe(0);
  expect((await operator.command("user.activate", id, restored.updatedAt.toISOString(), {})).statusCode).toBe(200);
  expect((await operator.command("user.activate", id, restored.updatedAt.toISOString(), {})).json().result.alreadyActive).toBe(true);
  expect((await publicPost("login", { email: input.email, password: permanent })).statusCode).toBe(200);
  expect(await prisma.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ emailVerifiedAt: null, activationRequired: false,
    manualActivatedAt: expect.any(Date) });
  expect(await prisma.order.count()).toBe(0);
  expect(await prisma.paymentTransaction.count()).toBe(0);
  expect(await prisma.subscription.count()).toBe(0);
  expect(await prisma.panelBinding.count()).toBe(0);
});

it("finishes a pending registration with a new temporary credential instead of the unverified submitted password", async () => {
  const admin = await createEnrolledAdmin("operator@example.invalid");
  const request = await prisma.pendingRegistration.create({ data: {
    email: "pending-registration@example.invalid", tokenHash: randomUUID(), passwordHash: await hashPassword(PASSWORD),
    expiresAt: new Date(Date.now() + 60_000),
  } });
  const api = as(adminApp, admin.sessionToken);
  const rows = (await api.get("/api/users/registrations")).json();
  expect(rows.items).toEqual([expect.objectContaining({ id: request.id, email: request.email })]);
  expect(JSON.stringify(rows)).not.toContain(request.passwordHash);
  const reply = await api.command("user.registration.activate", request.id, request.createdAt.toISOString(), { temporaryPassword: temp });
  expect(reply.statusCode).toBe(200);
  expect(await prisma.pendingRegistration.count()).toBe(0);
  expect((await publicPost("login", { email: request.email, password: PASSWORD })).statusCode).toBe(401);
  expect((await publicPost("login", { email: request.email, password: temp })).json().error.code).toBe("TEMPORARY_PASSWORD");
  expect(await prisma.user.findUniqueOrThrow({ where: { email: request.email } })).toMatchObject({
    emailVerifiedAt: null, manualActivatedAt: expect.any(Date),
  });
  expect(await prisma.notificationOutbox.count()).toBe(0);
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
