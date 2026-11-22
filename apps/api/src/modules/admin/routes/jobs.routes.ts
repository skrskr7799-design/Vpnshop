import { paginationSchema } from "@vpn/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { requeueFailedJob } from "../../fulfillment/fulfillment.queue";
import { writeAudit } from "../admin.audit";
import { adminOf, requireAdmin } from "../admin.middleware";

const listQuery = paginationSchema.extend({ status: z.enum(["PENDING", "RUNNING", "DONE", "FAILED"]).optional() });

export const adminJobsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/jobs", { preHandler: requireAdmin("jobs:read") }, async (req) => {
    const { page, pageSize, status } = listQuery.parse(req.query);
    const where = { assignmentId: null, status };
    const [items, total] = await Promise.all([
      prisma.fulfillmentJob.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          order: {
            select: {
              id: true,
              status: true,
              durationMonths: true,
              deviceLimit: true,
              amount: true,
              currency: true,
              user: { select: { id: true, email: true } },
            },
          },
        },
      }),
      prisma.fulfillmentJob.count({ where }),
    ]);
    return { items, total, page, pageSize };
  });

  app.get("/jobs/revision", { preHandler: requireAdmin("jobs:read") }, async req => {
    const { page, pageSize } = paginationSchema.parse(req.query);
    const jobs = await prisma.fulfillmentJob.findMany({
      where: { assignmentId: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize, take: pageSize,
      select: {
        id: true, status: true, attempts: true, writes: true, lastError: true, nextAttemptAt: true,
        assignment: { select: { subscriptionId: true, revision: true, enabled: true } },
      },
    });
    return { jobs, page, pageSize };
  });

  // Вернуть упавшую выдачу в очередь после того, как причина устранена
  app.post("/jobs/:id/requeue", { preHandler: requireAdmin("jobs:write") }, async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    await prisma.$transaction(async (tx) => {
      const ok = await requeueFailedJob(id, new Date(), tx);
      if (!ok) throw new AppError(409, "NOT_FAILED");
      await writeAudit(tx, { actorId: adminOf(req).userId, ip: req.ip, action: "job.requeue", entity: "fulfillment_job", entityId: id });
    });
    return reply.code(204).send();
  });
};
