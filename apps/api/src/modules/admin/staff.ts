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
import { invalidateStaff, lockStaffWrites } from "./auth/admin-auth.service";

const role = z.enum(["ADMIN", "SUPPORT"]);
const emailAddress = z.email().max(254).transform(value => value.toLowerCase());
const idParams = z.object({ id: z.uuid() });
const staffRoles = ["ADMIN", "SUPPORT"] as const;
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

async function protectLastAdmin(context: CommandContext, userId: string) {
  if (!await context.db.user.count({ where: { id: { not: userId }, role: "ADMIN", status: "ACTIVE",
    staffCredential: { isNot: null }, totp: { confirmedAt: { not: null } } } })) throw new AppError(409, "LAST_ADMIN");
}

export const staffCommands = {
  "staff.invite": command("staff:write", z.strictObject({ email: emailAddress, role }), async (ctx, input) => {
    expectVersion(ctx.expectedVersion, 0);
    if (ctx.targetId !== input.email) throw new AppError(400, "INVALID_TARGET");
    if (await ctx.db.user.findUnique({ where: { email: input.email } })) throw new AppError(409, "STAFF_ADDRESS_IN_USE");
    await ctx.db.staffInvite.updateMany({
      where: { email: input.email, consumedAt: null, expiresAt: { gt: ctx.now } }, data: { expiresAt: ctx.now },
    });
    const token = generateToken();
    const invite = await ctx.db.staffInvite.create({ data: {
      ...input, tokenHash: sha256(token), expiresAt: new Date(+ctx.now + 86_400_000),
    }, select: { id: true, role: true, expiresAt: true } });
    ctx.transient.invitationToken = token;
    return { id: invite.id, role: invite.role, expiresAt: invite.expiresAt.toISOString() };
  }),
  "staff.role": command("staff:write", z.strictObject({ role: z.enum(["ADMIN", "SUPPORT", "DISABLED"]) }), async (ctx, input) => {
    const { owner, credential } = await staffTarget(ctx);
    if (owner.id === ctx.actor.userId) throw new AppError(409, "SELF_ROLE_CHANGE");
    if (owner.role === "ADMIN" && owner.status === "ACTIVE" && input.role !== "ADMIN") await protectLastAdmin(ctx, owner.id);
    await ctx.db.user.update({ where: { id: owner.id }, data: input.role === "DISABLED"
      ? { status: "BLOCKED" } : { role: input.role, status: "ACTIVE" } });
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
    if (owner.role === "ADMIN" && owner.status === "ACTIVE") await protectLastAdmin(ctx, owner.id);
    await invalidateStaff(ctx.db, owner.id, ctx.now, true);
    await ctx.db.staffReset.update({ where: { id: request.id }, data: { approvedBy: ctx.actor.userId } });
    return { id: request.id, version: credential.version + 1 };
  }),
};

export const staffRoutes: FastifyPluginAsync = async app => {
  app.post("/auth/invitations/accept", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const input = z.strictObject({ token: z.string().min(32).max(128), password: z.string().min(12).max(128) }).parse(req.body);
    const tokenHash = sha256(input.token);
    const known = await prisma.staffInvite.findUnique({ where: { tokenHash } });
    if (!known || known.consumedAt || known.expiresAt <= new Date()) throw new AppError(400, "INVITE_INVALID");
    const passwordHash = await hashPassword(input.password);
    await prisma.$transaction(async db => {
      await lockStaffWrites(db);
      const now = await dbNow(db);
      const consumed = await db.staffInvite.updateMany({
        where: { id: known.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now },
      });
      if (!consumed.count || await db.user.findUnique({ where: { email: known.email } })) throw new AppError(400, "INVITE_INVALID");
      const user = await db.user.create({ data: { email: known.email, role: known.role, staffCredential: { create: { passwordHash } } } });
      await writeAudit(db, { actorId: user.id, role: user.role, action: "staff.invite.accept", entity: "staff", entityId: user.id, correlationId: req.id });
    });
    return reply.code(204).send();
  });
  app.get("/staff", { preHandler: requireAdmin("staff:read") }, async req => {
    const query = keysetQuery.extend({ role: role.optional() }).parse(req.query);
    const scope = "staff:" + (query.role ?? "all");
    const rows = await prisma.user.findMany({ where: {
      role: query.role ?? { in: [...staffRoles] }, ...keysetWhere(scope, query.cursor),
    }, orderBy: newestFirst, take: query.limit + 1, select: {
      id: true, email: true, role: true, status: true, createdAt: true, totp: { select: { confirmedAt: true } },
      staffCredential: { select: { version: true } },
    } });
    return keysetPage(scope, rows, query.limit, row => ({
      id: row.id, email: row.email, role: row.role, status: row.status, version: row.staffCredential?.version ?? null,
      enrollmentState: !row.staffCredential ? "REVIEW" : row.totp?.confirmedAt ? "ENROLLED" : "PENDING",
    }));
  });
  app.get("/staff/:id", { preHandler: requireAdmin("staff:read") }, async req => {
    const { id } = idParams.parse(req.params);
    const row = await prisma.user.findFirst({ where: { id, role: { in: [...staffRoles] } }, select: {
      id: true, role: true, status: true, email: true, createdAt: true, updatedAt: true,
      totp: { select: { confirmedAt: true } }, staffCredential: { select: { version: true } },
      staffResets: { take: 25, orderBy: [{ expiresAt: "desc" }, { id: "desc" }],
        select: { id: true, actorId: true, approvedBy: true, caseId: true, expiresAt: true } },
    } });
    if (!row) throw new AppError(404, "NOT_FOUND");
    return { id: row.id, role: row.role, status: row.status, email: row.email, createdAt: row.createdAt,
      updatedAt: row.updatedAt, enrolledAt: row.totp?.confirmedAt ?? null, version: row.staffCredential?.version ?? null,
      resets: row.staffResets };
  });
  async function sessionPage(userId: string, current: string, { limit, cursor }: z.infer<typeof keysetQuery>) {
    const scope = "staff-sessions:" + userId;
    const rows = await prisma.adminSession.findMany({
      where: { userId, ...keysetWhere(scope, cursor) }, orderBy: newestFirst, take: limit + 1, select: safeSession,
    });
    return keysetPage(scope, rows, limit, row => ({ ...row, current: row.id === current }));
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
