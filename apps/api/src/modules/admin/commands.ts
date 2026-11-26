import { createHmac, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { checkoutKeySchema } from "@vpn/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sha256 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { verifyPassword } from "../auth/password";
import { lockIdentityOwner } from "../auth/session.service";
import { dbNow } from "../commerce/offers";
import { writeAudit } from "./admin.audit";
import { stageTokenKey } from "./admin.keys";
import { adminOf, requireAdmin } from "./admin.middleware";
import { can, isAdminRole, type Permission } from "./admin.permissions";
import { acceptStaffTotp, lockStaffWrites } from "./auth/admin-auth.service";
import { assertCurrentPolicy, requiresFactor } from "./auth/policy";
import type { AdminContext } from "./auth/admin-session.service";

type Db = Prisma.TransactionClient;
export type CommandContext = {
  db: Db; actor: AdminContext; targetId: string; expectedVersion: string; reason: string;
  now: Date; commandId: string; transient: { invitationToken?: string; stageToken?: string };
};
const reason = z.string().trim().min(5).max(500).refine(value =>
  !/https?:\/\/|otpauth:|bearer\s|(?:password|token|пароль)\s*[:=]/i.test(value));

const envelope = {
  expectedVersion: z.union([z.number().int().nonnegative().transform(String), z.string().min(1).max(80)]),
  reason,
  command: z.unknown(),
};
const proofInput = z.strictObject({
  ...envelope, operation: z.string().min(1).max(80), permission: z.string().min(1).max(40),
  targetId: z.string().min(1).max(200), password: z.string().min(1).max(128), code: z.string().regex(/^\d{6}$/).optional(),
});
const executeInput = z.strictObject({ ...envelope, confirmationId: z.uuid() });

export function command<T>(permission: Permission, schema: z.ZodType<T>,
  apply: (context: CommandContext, input: T) => Promise<Prisma.InputJsonObject>) {
  return { permission, parse: (data: unknown) => schema.parse(data), run: (context: CommandContext, data: unknown) => apply(context, schema.parse(data)) };
}
export type Commands = Record<string, ReturnType<typeof command>>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
}
export const commandFingerprint = (operation: string, permission: Permission, target: string, input: {
  expectedVersion: string; reason: string; command: unknown;
}) => createHmac("sha256", stageTokenKey()).update(JSON.stringify(canonical(
  [operation, permission, target, input.expectedVersion, input.reason, input.command],
))).digest("hex");

export function expectVersion(expected: string, current: number | string | Date) {
  if (expected !== (current instanceof Date ? current.toISOString() : String(current))) throw new AppError(409, "VERSION_CONFLICT");
}

export async function lockActor(db: Db, actor: AdminContext, permission?: Permission) {
  const user = await lockIdentityOwner(db, actor.userId);
  if (!user || user.status !== "ACTIVE" || !isAdminRole(user.role)) throw new AppError(401, "UNAUTHENTICATED");
  await assertCurrentPolicy(db);
  const [session, credential, factor] = await Promise.all([
    db.adminSession.findFirst({ where: { id: actor.sessionId, userId: user.id, revokedAt: null } }),
    db.staffCredential.findUnique({ where: { userId: user.id } }),
    db.adminTotp.findUnique({ where: { userId: user.id }, select: { confirmedAt: true } }),
  ]);
  const now = await dbNow(db);
  if (!session || !credential || credential.temporaryUntil || credential.deactivatedAt ||
      session.policy !== env.ADMIN_2FA_POLICY || requiresFactor(!!factor?.confirmedAt) && (!factor?.confirmedAt || !session.factorVerified) ||
      session.expiresAt <= now || session.idleExpiresAt <= now) throw new AppError(401, "UNAUTHENTICATED");
  if (permission && !can(user.role, permission)) throw new AppError(403, "FORBIDDEN");
  return { now, actor: { ...actor, role: user.role }, credential };
}

export function registerCommandProtocol(app: FastifyInstance, commands: Commands) {
  const read = (name: string) => {
    const entry = Object.hasOwn(commands, name) ? commands[name] : undefined;
    if (!entry) throw new AppError(404, "NOT_FOUND");
    return entry;
  };

  app.post("/auth/step-up", { preHandler: requireAdmin(), config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (req, reply) => {
    const input = proofInput.parse(req.body);
    const entry = read(input.operation);
    const actor = adminOf(req);
    if (input.permission !== entry.permission || !can(actor.role, entry.permission)) throw new AppError(403, "FORBIDDEN");
    const command = entry.parse(input.command);
    const hash = commandFingerprint(input.operation, entry.permission, input.targetId, { ...input, command });
    const known = await prisma.staffCredential.findUnique({ where: { userId: actor.userId } });
    if (!known || !await verifyPassword(known.passwordHash, input.password)) {
      await writeAudit(prisma, { actorId: actor.userId, action: "admin.step_up.denied", permission: entry.permission,
        entity: "admin", outcome: "DENIED", correlationId: req.id });
      throw new AppError(401, "INVALID_CREDENTIALS");
    }
    const proof = await prisma.$transaction(async db => {
      await lockStaffWrites(db);
      const current = await lockActor(db, actor, entry.permission);
      if (current.credential.version !== known.version) throw new AppError(403, "STEP_UP_REQUIRED");
      const factor = await db.adminTotp.findUnique({ where: { userId: actor.userId } });
      if (requiresFactor(!!factor?.confirmedAt) &&
          (!factor?.confirmedAt || !input.code || !await acceptStaffTotp(db, factor, input.code, current.now))) return null;
      return db.adminConfirmation.create({ data: {
        sessionId: actor.sessionId, fingerprint: hash, version: known.version, expiresAt: new Date(+current.now + 5 * 60_000),
      }, select: { id: true, expiresAt: true } });
    });
    if (!proof) throw new AppError(401, "INVALID_CODE");
    return reply.send({ confirmationId: proof.id, expiresAt: proof.expiresAt });
  });

  const execute = async (req: FastifyRequest, operation: string, targetId: string) => {
    const entry = read(operation);
    const actor = adminOf(req);
    if (!can(actor.role, entry.permission)) throw new AppError(403, "FORBIDDEN");
    const input = executeInput.parse(req.body);
    const command = entry.parse(input.command);
    const fingerprintValue = commandFingerprint(operation, entry.permission, targetId, { ...input, command });
    const keyHash = sha256(checkoutKeySchema.parse(req.headers["idempotency-key"]));
    const transient: CommandContext["transient"] = {};
    const result = await prisma.$transaction(async db => {
      await lockStaffWrites(db);
      const current = await lockActor(db, actor, entry.permission);
      const key = { actorId: actor.userId, operation, targetId, keyHash };
      const prior = await db.adminCommand.findUnique({ where: { actorId_operation_targetId_keyHash: key } });
      if (prior) {
        if (prior.fingerprint !== fingerprintValue) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
        return { commandId: prior.id, status: "SUCCEEDED", targetId, result: prior.result };
      }
      const consumed = await db.adminConfirmation.updateMany({ where: {
        id: input.confirmationId, sessionId: actor.sessionId, fingerprint: fingerprintValue,
        version: current.credential.version, consumedAt: null, expiresAt: { gt: current.now },
      }, data: { consumedAt: current.now } });
      if (consumed.count !== 1) throw new AppError(403, "STEP_UP_REQUIRED");

      const commandId = randomUUID();
      const output = await entry.run({ db, actor: current.actor, targetId, reason: input.reason,
        expectedVersion: input.expectedVersion, now: current.now, commandId, transient }, input.command);
      await db.adminCommand.create({ data: { ...key, id: commandId, fingerprint: fingerprintValue, permission: entry.permission, result: output } });
      await writeAudit(db, { actorId: actor.userId, role: current.actor.role, permission: entry.permission,
        reason: input.reason, action: operation, entity: operation.split(".")[0]!, entityId: operation === "staff.create" || operation === "user.create" || operation === "user.registration.activate" ? String(output.id) : targetId,
        commandId, correlationId: req.id, outcome: "SUCCEEDED", ip: req.ip, data: output });
      // Object lock waits are included in the freshness check. Failure rolls back the effect.
      const proof = await db.adminConfirmation.findUniqueOrThrow({ where: { id: input.confirmationId }, select: { expiresAt: true } });
      if (proof.expiresAt <= await dbNow(db)) throw new AppError(403, "STEP_UP_REQUIRED");
      return { commandId, status: "SUCCEEDED", targetId, result: output };
    });
    return { ...result, ...transient };
  };

  app.post("/commands/:operation/:target", { preHandler: requireAdmin() }, req => {
    const { operation, target } = z.object({ operation: z.string().max(80), target: z.string().min(1).max(200) }).parse(req.params);
    return execute(req, operation, target);
  });
  app.get("/commands/:id", { preHandler: requireAdmin() }, async req => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const actor = adminOf(req);
    const row = await prisma.adminCommand.findFirst({ where: { id, actorId: actor.userId } });
    if (!row || !can(actor.role, read(row.operation).permission)) throw new AppError(404, "NOT_FOUND");
    return { commandId: row.id, targetId: row.targetId, status: "SUCCEEDED", updatedAt: row.createdAt };
  });
  return execute;
}
