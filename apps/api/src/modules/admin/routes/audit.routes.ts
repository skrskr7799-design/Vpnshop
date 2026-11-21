import { paginationSchema } from "@vpn/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../../../lib/prisma";
import { requireAdmin } from "../admin.middleware";

const listQuery = paginationSchema.extend({
  action: z.string().max(100).optional(), // префикс: "plan." покажет все действия с тарифами
  entity: z.string().max(50).optional(),
  actorId: z.uuid().optional(),
});

export const adminAuditRoutes: FastifyPluginAsync = async (app) => {
  app.get("/audit", { preHandler: requireAdmin("audit:read") }, async (req) => {
    const { page, pageSize, action, entity, actorId } = listQuery.parse(req.query);
    const where = {
      ...(action && { action: { startsWith: action } }),
      ...(entity && { entity }),
      ...(actorId && { actorId }),
    };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.auditLog.count({ where }),
    ]);

    // В журнале нет связи с пользователями (записи должны переживать их удаление): подставляем email отдельно
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
    const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } });
    const emailById = new Map(actors.map((a) => [a.id, a.email]));
    const items = rows.map((r) => ({ ...r, actorEmail: r.actorId ? (emailById.get(r.actorId) ?? null) : null }));
    return { items, total, page, pageSize };
  });
};
