import type { Prisma } from "@prisma/client";
import { staffUsernameSchema } from "@vpn/shared";
import { env } from "../../config/env";
import { isUniqueViolation } from "../../lib/db-errors";
import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";
import { generateToken, sha256 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { keysetPage, keysetQuery, keysetWhere, newestFirst } from "../../lib/keyset";
import { prisma } from "../../lib/prisma";
import { hashPassword } from "../auth/password";
import { lockIdentityOwner } from "../auth/session.service";
import { dbNow } from "../commerce/offers";
import { writeAudit } from "./admin.audit";
import { clearAdminCookie, adminOf, requireAdmin } from "./admin.middleware";
import { command, expectVersion, lockActor, type CommandContext } from "./commands";
import { createStaffAccount, invalidateStaff, issueStaffStage, lockStaffWrites, TEMPORARY_PASSWORD_MS } from "./auth/admin-auth.service";

const role = z.enum(["OWNER", "ADMIN", "SUPPORT"]);
const inviteRole = z.enum(["ADMIN", "SUPPORT"]);
const displayName = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}]+$/u);
const temporaryPassword = z.string().min(12).max(128);
const emailAddress = z.email().max(254).transform(value => value.toLowerCase());
const idParams = z.object({ id: z.uuid() });
const staffRoles = role.options;
const safeSession = {
  id: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true, idleExpiresAt: true, revokedAt: true,
} as const;
async function staffTarget({ db, targetId, expectedVersion }: CommandContext) {
  const owner = await lockIdentityOwner(db, targetId);
  const credential = await db.staffCredential.findUnique({ where: { userId: targetId } });
  if (!owner || owner.role === "USER" || !credential) throw new AppError(404, "NOT_FOUND");
  expectVersion(expectedVersion, credential.version);
  return { owner, credential };
}

async function protectLastOwner(ctx: CommandContext, owner: { id: string; role: string; status: string }) {
  if (owner.role !== "OWNER" || owner.status !== "ACTIVE") return;
  const unlocked = { OR: [{ lockedUntil: null }, { lockedUntil: { lte: ctx.now } }] };
  const available: Prisma.UserWhereInput = env.ADMIN_2FA_POLICY === "disabled" ? {}
    : env.ADMIN_2FA_POLICY === "optional" ? { OR: [
      { totp: null }, { totp: { is: { confirmedAt: null } } }, { totp: { is: unlocked } },
    ] }
    : { totp: { is: { confirmedAt: { not: null }, ...unlocked } } };
  if (!await ctx.db.user.count({ where: { id: { not: owner.id }, role: "OWNER", status: "ACTIVE",
    staffCredential: { is: { temporaryUntil: null, deactivatedAt: null } }, ...available } })) throw new AppError(409, "LAST_OWNER");
}

async function guardStaffChange(ctx: CommandContext, target: Awaited<ReturnType<typeof staffTarget>>) {
  if (target.owner.id === ctx.actor.userId) throw new AppError(409, "SELF_ROLE_CHANGE");
  if (target.credential.deactivatedAt) throw new AppError(409, "STAFF_DEACTIVATED");
}

const liveSessions = (now: Date) => ({ revokedAt: null, expiresAt: { gt: now }, idleExpiresAt: { gt: now } });

export const staffCommands = {
  "staff.create": command("staff:write", z.strictObject({
    username: staffUsernameSchema, displayName: displayName.optional(), contactEmail: emailAddress.optional(),
    role, temporaryPassword,
  }), async (ctx, input) => {
    expectVersion(ctx.expectedVersion, 0);
    if (ctx.targetId !== "new") throw new AppError(400, "INVALID_TARGET");
    const { temporaryPassword, ...profile } = input;
    try {
      const user = await createStaffAccount(ctx.db, { ...profile, passwordHash: await hashPassword(temporaryPassword),
        temporaryUntil: new Date(+ctx.now + TEMPORARY_PASSWORD_MS) });
      return { id: user.id, username: input.username, role: user.role };
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, "STAFF_USERNAME_IN_USE");
      throw error;
    }
  }),
  "staff.profile": command("staff:write", z.strictObject({
    username: staffUsernameSchema.optional(), displayName: displayName.nullable().optional(),
    contactEmail: emailAddress.nullable().optional(),
  }).refine(profile => Object.keys(profile).length > 0), async (ctx, input) => {
    const { owner, credential } = await staffTarget(ctx);
    if (credential.deactivatedAt) throw new AppError(409, "STAFF_DEACTIVATED");
    try {
      await ctx.db.staffCredential.update({ where: { userId: owner.id }, data: input });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, "STAFF_USERNAME_IN_USE");
      throw error;
    }
    await invalidateStaff(ctx.db, owner.id, ctx.now);
    return { id: owner.id, beforeUsername: credential.username, username: input.username ?? credential.username,
      changed: Object.keys(input), version: credential.version + 1 };
  }),
  "staff.status": command("staff:write", z.strictObject({ status: z.enum(["ACTIVE", "BLOCKED", "DEACTIVATED"]) }), async (ctx, input) => {
    const target = await staffTarget(ctx);
    const { owner, credential } = target;
    await guardStaffChange(ctx, target);
    if (input.status !== "ACTIVE") await protectLastOwner(ctx, owner);
    await ctx.db.user.update({ where: { id: owner.id }, data: { status: input.status === "ACTIVE" ? "ACTIVE" : "BLOCKED" } });
    if (input.status === "DEACTIVATED") await ctx.db.staffCredential.update({ where: { userId: owner.id }, data: { deactivatedAt: ctx.now } });
    await invalidateStaff(ctx.db, owner.id, ctx.now);
    return { id: owner.id, before: owner.status, status: input.status, version: credential.version + 1 };
  }),
  "staff.password.reset": command("staff:write", z.strictObject({ temporaryPassword }), async (ctx, input) => {
    const target = await staffTarget(ctx);
    await guardStaffChange(ctx, target);
    await protectLastOwner(ctx, target.owner);
    await ctx.db.staffCredential.update({ where: { userId: ctx.targetId }, data: {
      passwordHash: await hashPassword(input.temporaryPassword), temporaryUntil: new Date(+ctx.now + TEMPORARY_PASSWORD_MS),
    } });
    await invalidateStaff(ctx.db, ctx.targetId, ctx.now);
    return { id: ctx.targetId, version: target.credential.version + 1 };
  }),
  "staff.totp.reset": command("staff:write", z.strictObject({}), async ctx => {
    const target = await staffTarget(ctx);
    await guardStaffChange(ctx, target);
    await invalidateStaff(ctx.db, ctx.targetId, ctx.now, true);
    return { id: ctx.targetId, version: target.credential.version + 1 };
  }),
  "staff.sessions.revoke": command("staff:write", z.strictObject({}), async ctx => {
    const { credential } = await staffTarget(ctx);
    await invalidateStaff(ctx.db, ctx.targetId, ctx.now);
    return { id: ctx.targetId, version: credential.version + 1 };
  }),
  "staff.self.totp.enroll": command("security:self", z.strictObject({}), async ctx => {
    if (ctx.targetId !== ctx.actor.userId || env.ADMIN_2FA_POLICY !== "optional") throw new AppError(403, "FORBIDDEN");
    const { credential } = await staffTarget(ctx);
    const factor = await ctx.db.adminTotp.findUnique({ where: { userId: ctx.targetId } });
    if (factor?.confirmedAt) throw new AppError(409, "ALREADY_ENROLLED");
    ctx.transient.stageToken = await issueStaffStage(ctx.db, ctx.targetId, credential.version, "enroll", ctx.now);
    return { id: ctx.targetId };
  }),
  "staff.self.totp.disable": command("security:self", z.strictObject({}), async ctx => {
    if (ctx.targetId !== ctx.actor.userId || env.ADMIN_2FA_POLICY !== "optional") throw new AppError(403, "FORBIDDEN");
    const { credential } = await staffTarget(ctx);
    await invalidateStaff(ctx.db, ctx.targetId, ctx.now, true);
    return { id: ctx.targetId, version: credential.version + 1 };
  }),
  "staff.invite": command("staff:write", z.strictObject({ email: emailAddress, role: inviteRole }), async (ctx, input) => {
    expectVersion(ctx.expectedVersion, 0);
    if (ctx.targetId !== input.email) throw new AppError(400, "INVALID_TARGET");
    if (await ctx.db.user.findUnique({ where: { email: input.email } })) throw new AppError(409, "STAFF_ADDRESS_IN_USE");
    await ctx.db.staffInvite.updateMany({
      where: { email: input.email, consumedAt: null, expiresAt: { gt: ctx.now } }, data: { expiresAt: ctx.now },
    });
    const token = generateToken();
    const invite = await ctx.db.staffInvite.create({ data: {
      ...input, issuedBy: ctx.actor.userId, tokenHash: sha256(token), expiresAt: new Date(+ctx.now + 86_400_000),
    }, select: { id: true, role: true, expiresAt: true } });
    ctx.transient.invitationToken = token;
    return { id: invite.id, role: invite.role, expiresAt: invite.expiresAt.toISOString() };
  }),
  "staff.role": command("staff:write", z.strictObject({ role: z.enum(["OWNER", "ADMIN", "SUPPORT", "DISABLED"]) }), async (ctx, input) => {
    const { owner, credential } = await staffTarget(ctx);
    await guardStaffChange(ctx, { owner, credential });
    if (input.role !== "OWNER") await protectLastOwner(ctx, owner);
    await ctx.db.user.update({ where: { id: owner.id }, data: input.role === "DISABLED"
      ? { status: "BLOCKED" } : { role: input.role } });
    await invalidateStaff(ctx.db, owner.id, ctx.now);
    return { userId: owner.id, before: owner.role, after: input.role, version: credential.version + 1 };
  }),
  "staff.session.revoke": command("staff:write", z.strictObject({ sessionId: z.uuid() }), async (ctx, input) => {
    await staffTarget(ctx);
    const { count } = await ctx.db.adminSession.updateMany({
      where: { id: input.sessionId, userId: ctx.targetId, revokedAt: null }, data: { revokedAt: ctx.now },
    });
    if (!count && !await ctx.db.adminSession.findFirst({ where: { id: input.sessionId, userId: ctx.targetId } })) throw new AppError(404, "NOT_FOUND");
    return { sessionId: input.sessionId, revoked: true };
  }),
  "staff.totp.request": command("staff:write", z.strictObject({ recoveryCaseId: z.string().regex(/^[A-Za-z0-9._-]{3,100}$/) }), async (ctx, input) => {
    const { credential } = await staffTarget(ctx);
    const request = await ctx.db.staffReset.create({ data: { userId: ctx.targetId, actorId: ctx.actor.userId,
      version: credential.version, caseId: input.recoveryCaseId, expiresAt: new Date(+ctx.now + 30 * 60_000) } });
    return { id: request.id, expiresAt: request.expiresAt.toISOString() };
  }),
  "staff.totp.approve": command("staff:write", z.strictObject({ requestId: z.uuid() }), async (ctx, input) => {
    const { owner, credential } = await staffTarget(ctx);
    const request = await ctx.db.staffReset.findFirst({ where: {
      id: input.requestId, userId: owner.id, version: credential.version, expiresAt: { gt: ctx.now }, approvedBy: null,
    } });
    if (!request) throw new AppError(409, "UNAPPROVED_RECOVERY");
    if (request.actorId === ctx.actor.userId || owner.id === ctx.actor.userId) throw new AppError(409, "SAME_APPROVER");
    await invalidateStaff(ctx.db, owner.id, ctx.now, true);
    await ctx.db.staffReset.update({ where: { id: request.id }, data: { approvedBy: ctx.actor.userId } });
    return { id: request.id, version: credential.version + 1 };
  }),
};

const staffSummary = (now: Date) => ({
  id: true, email: true, role: true, status: true, createdAt: true, totp: { select: { confirmedAt: true } },
  staffCredential: { select: { username: true, displayName: true, contactEmail: true,
    version: true, lastLoginAt: true, deactivatedAt: true, temporaryUntil: true } },
  _count: { select: { adminSessions: { where: liveSessions(now) } } },
} as const);

function staffDto(row: Prisma.UserGetPayload<{ select: ReturnType<typeof staffSummary> }>) {
  const credential = row.staffCredential;
  return { id: row.id, email: credential ? credential.contactEmail : row.email, username: credential?.username ?? null,
    displayName: credential?.displayName ?? null, role: row.role,
    status: credential?.deactivatedAt ? "DEACTIVATED" : row.status, createdAt: row.createdAt,
    version: credential?.version ?? null, lastLoginAt: credential?.lastLoginAt ?? null,
    temporaryUntil: credential?.temporaryUntil ?? null, activeSessions: row._count.adminSessions,
    enrollmentState: !credential ? "REVIEW" : row.totp?.confirmedAt ? "ENROLLED" : "PENDING" };
}

export const staffRoutes: FastifyPluginAsync = async app => {
  app.post("/auth/invitations/accept", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const input = z.strictObject({ token: z.string().min(32).max(128), password: z.string().min(12).max(128), username: staffUsernameSchema.optional() }).parse(req.body);
    const tokenHash = sha256(input.token);
    const known = await prisma.staffInvite.findUnique({ where: { tokenHash } });
    if (!known || known.consumedAt || known.expiresAt <= new Date()) throw new AppError(400, "INVITE_INVALID");
    const passwordHash = await hashPassword(input.password);
    await prisma.$transaction(async db => {
      await lockStaffWrites(db);
      const now = await dbNow(db);
      const issuer = known.issuedBy && await db.user.findFirst({ where: { id: known.issuedBy, role: "OWNER", status: "ACTIVE",
        staffCredential: { is: { temporaryUntil: null, deactivatedAt: null } } }, select: { id: true } });
      if (!issuer) throw new AppError(400, "INVITE_INVALID");
      const consumed = await db.staffInvite.updateMany({
        where: { id: known.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now },
      });
      if (!consumed.count || await db.user.findUnique({ where: { email: known.email } })) throw new AppError(400, "INVITE_INVALID");
      if (known.role !== "ADMIN" && known.role !== "SUPPORT") throw new AppError(400, "INVITE_INVALID");
      const username = input.username ?? "invite-" + known.id;
      if (await db.staffCredential.findUnique({ where: { username } })) throw new AppError(409, "STAFF_USERNAME_IN_USE");
      const user = await createStaffAccount(db, { username, passwordHash, role: known.role, contactEmail: known.email });
      await writeAudit(db, { actorId: user.id, role: user.role, action: "staff.invite.accept", entity: "staff", entityId: user.id, correlationId: req.id });
    });
    return reply.code(204).send();
  });
  app.get("/staff", { preHandler: requireAdmin("staff:read") }, async req => {
    const query = keysetQuery.extend({ role: role.optional(), q: z.string().trim().max(80).optional(),
      status: z.enum(["ACTIVE", "BLOCKED", "DEACTIVATED"]).optional() }).parse(req.query);
    const scope = JSON.stringify(["staff", query.role, query.status, query.q]);
    const now = new Date();
    const rows = await prisma.user.findMany({ where: {
      role: query.role ?? { in: [...staffRoles] },
      ...(query.status === "DEACTIVATED" ? { staffCredential: { is: { deactivatedAt: { not: null } } } }
        : query.status ? { status: query.status, NOT: { staffCredential: { is: { deactivatedAt: { not: null } } } } } : {}),
      ...(query.q ? { OR: [
        { staffCredential: { is: { username: { contains: query.q.toLowerCase() } } } },
        { staffCredential: { is: { displayName: { contains: query.q, mode: "insensitive" } } } },
      ] } : {}),
      ...keysetWhere(scope, query.cursor),
    }, orderBy: newestFirst, take: query.limit + 1, select: staffSummary(now) });
    return keysetPage(scope, rows, query.limit, staffDto);
  });
  app.get("/staff/:id", { preHandler: requireAdmin("staff:read") }, async req => {
    const { id } = idParams.parse(req.params);
    const row = await prisma.user.findFirst({ where: { id, role: { in: [...staffRoles] } }, select: {
      ...staffSummary(new Date()), updatedAt: true,
      staffResets: { take: 25, orderBy: [{ expiresAt: "desc" }, { id: "desc" }],
        select: { id: true, actorId: true, approvedBy: true, caseId: true, expiresAt: true } },
    } });
    if (!row) throw new AppError(404, "NOT_FOUND");
    return { ...staffDto(row), updatedAt: row.updatedAt, enrolledAt: row.totp?.confirmedAt ?? null, resets: row.staffResets };
  });
  async function sessionPage(userId: string, current: string, { limit, cursor }: z.infer<typeof keysetQuery>) {
    const scope = "staff-sessions:" + userId;
    const rows = await prisma.adminSession.findMany({
      where: { userId, ...keysetWhere(scope, cursor) }, orderBy: newestFirst, take: limit + 1, select: safeSession,
    });
    const now = new Date();
    return keysetPage(scope, rows, limit, row => ({ ...row, current: row.id === current,
      state: row.revokedAt ? "REVOKED" : row.expiresAt <= now || row.idleExpiresAt <= now ? "EXPIRED" : "ACTIVE" }));
  }
  app.get("/auth/sessions", { preHandler: requireAdmin() }, req => {
    const actor = adminOf(req);
    return sessionPage(actor.userId, actor.sessionId, keysetQuery.parse(req.query));
  });
  app.get("/staff/:id/sessions", { preHandler: requireAdmin("staff:read") }, async req => {
    const { id } = idParams.parse(req.params);
    if (!await prisma.staffCredential.findUnique({ where: { userId: id }, select: { userId: true } })) throw new AppError(404, "NOT_FOUND");
    return sessionPage(id, adminOf(req).sessionId, keysetQuery.parse(req.query));
  });
  app.post("/auth/sessions/revoke-others", { preHandler: requireAdmin() }, async (req, reply) => {
    const caller = adminOf(req);
    await prisma.$transaction(async db => {
      await lockStaffWrites(db);
      const { actor, now } = await lockActor(db, caller);
      const result = await db.adminSession.updateMany({
        where: { userId: actor.userId, id: { not: actor.sessionId }, revokedAt: null }, data: { revokedAt: now },
      });
      await writeAudit(db, { actorId: actor.userId, role: actor.role, action: "staff.sessions.revoke_others",
        entity: "staff", entityId: actor.userId, correlationId: req.id, data: { count: result.count } });
    });
    return reply.code(204).send();
  });
  app.delete("/auth/sessions/:id", { preHandler: requireAdmin() }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const caller = adminOf(req);
    await prisma.$transaction(async db => {
      await lockStaffWrites(db);
      const { actor, now } = await lockActor(db, caller);
      const target = await db.adminSession.findFirst({ where: { id, userId: actor.userId } });
      if (!target) throw new AppError(404, "NOT_FOUND");
      if (target.revokedAt) return;
      await db.adminSession.update({ where: { id }, data: { revokedAt: now } });
      await writeAudit(db, { actorId: actor.userId, role: actor.role, action: "staff.session.owner_revoke",
        entity: "staff", entityId: id, correlationId: req.id });
    });
    if (id === caller.sessionId) clearAdminCookie(reply);
    return reply.code(204).send();
  });
};
