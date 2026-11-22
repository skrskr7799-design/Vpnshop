import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma";

export const schemaFloor = "20261123000000_notification_outbox";

export async function databaseReady() {
  try {
    const [row] = await prisma.$queryRaw<{ ready: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM "_prisma_migrations" WHERE migration_name = ${schemaFloor}
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ) AND NOT EXISTS (
        SELECT 1 FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL
      ) AS ready`;
    return row?.ready === true;
  } catch { return false; }
}

export function setDrain(app: FastifyInstance) {
  app.addHook("onRequest", async (_req, reply) => {
    if (app.draining) return reply.code(503).send({ error: { code: "DRAINING" } });
  });
}
declare module "fastify" { interface FastifyInstance { draining?: boolean } }

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_req, reply) => {
    const ready = !app.draining && await databaseReady();
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable" });
  });
}
