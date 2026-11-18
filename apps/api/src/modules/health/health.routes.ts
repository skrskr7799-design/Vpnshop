import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";

export async function healthRoutes(app: FastifyInstance) {
  // liveness: процесс жив
  app.get("/health", async () => ({ status: "ok" }));

  // readiness: готов обслуживать запросы (БД доступна)
  app.get("/ready", async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}
