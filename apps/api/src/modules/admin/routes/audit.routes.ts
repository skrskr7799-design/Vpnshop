import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../../../lib/errors";
import { keysetPage, keysetQuery, keysetWhere, newestFirst } from "../../../lib/keyset";
import { prisma } from "../../../lib/prisma";
import { requireAdmin } from "../admin.middleware";

const listQuery = keysetQuery.extend({
  action: z.string().max(100).optional(), entity: z.string().max(50).optional(),
  actorId: z.uuid().optional(), entityId: z.string().max(200).optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
});

export const adminAuditRoutes: FastifyPluginAsync = async app => {
  app.get("/audit", { preHandler: requireAdmin("audit:read") }, async req => {
    const { limit, cursor, action, from, to, ...filters } = listQuery.parse(req.query);
    const scope = JSON.stringify(["audit", action, filters, from, to]);
    const rows = await prisma.auditLog.findMany({
      where: { ...filters, action: action && { startsWith: action }, AND: [{ createdAt: { gte: from, lt: to } }, keysetWhere(scope, cursor)] },
      orderBy: newestFirst, take: limit + 1,
      select: { id: true, actorId: true, role: true, permission: true, action: true, entity: true, entityId: true,
        reason: true, commandId: true, correlationId: true, outcome: true, createdAt: true },
    });
    return keysetPage(scope, rows, limit, row => row);
  });
  app.get("/audit/:id", { preHandler: requireAdmin("audit:read") }, async req => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const log = await prisma.auditLog.findUnique({ where: { id }, select: {
      id: true, actorId: true, role: true, permission: true, action: true, entity: true, entityId: true,
      reason: true, commandId: true, correlationId: true, outcome: true, createdAt: true,
    } });
    if (!log) throw new AppError(404, "NOT_FOUND");
    // Only normalized command results are exposed alongside the audit entry.
    const command = log.commandId ? await prisma.adminCommand.findUnique({ where: { id: log.commandId },
      select: { result: true } }) : null;
    return { ...log, delta: command?.result ?? null };
  });

};
