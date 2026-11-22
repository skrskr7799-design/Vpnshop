import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../../../lib/errors";
import { prisma } from "../../../lib/prisma";
import { requeueFailedJob } from "../../fulfillment/fulfillment.queue";
import { writeAudit } from "../admin.audit";
import { adminOf, requireAdmin } from "../admin.middleware";


export const adminJobsRoutes: FastifyPluginAsync = async (app) => {
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
