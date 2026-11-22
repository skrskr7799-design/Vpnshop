import { databaseReady } from "./modules/health/health.routes";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { stagingPanel } from "./config/staging-panel";
import { panelSettings } from "./config/panel-env";
import { prisma } from "./lib/prisma";
import { DEFAULT_LEASE_MS } from "./modules/fulfillment/fulfillment.constants";
import { createFulfillmentWorker } from "./modules/fulfillment/fulfillment.worker";
import { refreshDueAssignments } from "./modules/subscriptions/store";
import { RemnawaveClient } from "./modules/remnawave/remnawave.client";

const settings = z.object({

  WORKER_HEALTH_HOST: z.string().default("127.0.0.1"),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WORKER_DRAIN_MS: z.coerce.number().int().min(100).max(300_000).default(55_000),
  WORKER_LEASE_MS: z.coerce.number().int().min(3000).max(600_000).default(DEFAULT_LEASE_MS),
  WORKER_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(20_000),
}).refine(v => v.WORKER_HTTP_TIMEOUT_MS + 250 < v.WORKER_LEASE_MS, "HTTP deadline must fit inside lease").safeParse(process.env);
if (!settings.success) throw new Error("Invalid worker configuration: " +
  settings.error.issues.map(i => i.path.join(".") || i.message).join(", "));
const config = settings.data;
const probes = Fastify({ logger: true, disableRequestLogging: true });
const staging = stagingPanel(config.WORKER_HTTP_TIMEOUT_MS);
if (staging) {
  const metadata = await staging.client.getMetadata().catch(() => { throw new Error("Staging metadata unavailable"); });
  if (metadata.version !== "3.4.9") throw new Error("Staging panel version differs from the pinned contract");
  const known = await staging.client.listInternalSquads().catch(() => { throw new Error("Staging squads unavailable"); });
  if (staging.squads.some(id => !known.some(squad => squad.uuid.toLowerCase() === id))) {
    throw new Error("Unknown staging internal squad");
  }
}
const legacy = process.env.NODE_ENV === "test" && !staging ? z.object(panelSettings).parse(process.env) : undefined;
const worker = createFulfillmentWorker({
  // Staging is explicit. Default runtime processes local period boundaries only.
  panel: staging?.panel,
  maintenance: legacy ? undefined : async () => { if (!await databaseReady()) throw new Error("SCHEMA_NOT_READY"); return refreshDueAssignments(); },
  api: legacy && new RemnawaveClient({
    baseUrl: legacy.REMNAWAVE_URL, token: legacy.REMNAWAVE_TOKEN, apiKey: legacy.REMNAWAVE_API_KEY,
    trustedProxyHeaders: legacy.REMNAWAVE_TRUSTED_PROXY_HEADERS, timeoutMs: config.WORKER_HTTP_TIMEOUT_MS,
  }),
  internalSquadUuids: legacy?.REMNAWAVE_INTERNAL_SQUAD_UUIDS ?? [],
  leaseMs: config.WORKER_LEASE_MS,
  log: probes.log,
});
probes.get("/health", async () => ({ status: "alive" }));
probes.get("/ready", async (_req, reply) => {
  const state = worker.status();
  const ready = state.ready && await databaseReady();
  return reply.code(ready ? 200 : 503).send({ ...state, ready });
});

const heartbeatId = randomUUID();
async function reportHeartbeat(ready: boolean) {
  try {
    const [clock] = await prisma.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    const observedAt = clock!.now;
    await prisma.workerHeartbeat.upsert({
      where: { id: heartbeatId }, create: { id: heartbeatId, observedAt, ready }, update: { observedAt, ready },
    });
    await prisma.workerHeartbeat.deleteMany({ where: { observedAt: { lt: new Date(+observedAt - 86_400_000) } } });
  } catch { probes.log.warn("Worker heartbeat is unavailable"); }
}
const heartbeat = setInterval(() => { if (!draining) void reportHeartbeat(worker.status().ready); }, 15_000);
heartbeat.unref();

let draining = false;
async function shutdown() {
  if (draining) return;
  draining = true;
  const deadline = setTimeout(() => {
    probes.log.warn("Drain deadline exceeded, active lease will expire");
    process.exit(1);
  }, config.WORKER_DRAIN_MS);
  try {
    clearInterval(heartbeat);
    await worker.stop();
    await reportHeartbeat(false);
    await probes.close();
    await prisma.$disconnect();
  } finally {
    clearTimeout(deadline);
  }
}
await probes.listen({ host: config.WORKER_HEALTH_HOST, port: config.WORKER_HEALTH_PORT });
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
worker.start();
