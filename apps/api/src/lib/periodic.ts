import { serviceLogger } from "./telemetry";
import Fastify from "fastify";
import { databaseReady } from "../modules/health/health.routes";
import { prisma } from "./prisma";

export async function runPeriodic(service: string, port: number, tick: () => Promise<unknown>) {
  const app = Fastify({ logger: serviceLogger(service), disableRequestLogging: true });
  let stopping = false;
  let lastRun = 0;
  let work: Promise<void> | undefined;
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_req, reply) => {
    const ready = !stopping && Date.now() - lastRun < 30_000 && await databaseReady();
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable" });
  });
  function run() {
    if (stopping || work) return;
    work = (async () => {
      if (!await databaseReady()) return;
      await tick();
      lastRun = Date.now();
    })().catch(() => app.log.warn({ reasonCode: "BACKGROUND_TICK_FAILED" })).finally(() => { work = undefined; });
  }
  const interval = setInterval(run, 3000);
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    const deadline = setTimeout(() => process.exit(1), 27_000).unref();
    try { await work; await app.close(); await prisma.$disconnect(); }
    finally { clearTimeout(deadline); }
  }
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await app.listen({ host: "0.0.0.0", port });
  run();
}
