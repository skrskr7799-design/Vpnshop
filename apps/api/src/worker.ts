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
  ...panelSettings,
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
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
const worker = createFulfillmentWorker({
  // Staging is explicit. Default runtime processes local period boundaries only.
  panel: staging?.panel,
  maintenance: process.env.NODE_ENV === "test" && !staging ? undefined : refreshDueAssignments,
  api: new RemnawaveClient({
    baseUrl: config.REMNAWAVE_URL, token: config.REMNAWAVE_TOKEN, apiKey: config.REMNAWAVE_API_KEY,
    trustedProxyHeaders: config.REMNAWAVE_TRUSTED_PROXY_HEADERS, timeoutMs: config.WORKER_HTTP_TIMEOUT_MS,
  }),
  internalSquadUuids: config.REMNAWAVE_INTERNAL_SQUAD_UUIDS,
  leaseMs: config.WORKER_LEASE_MS,
  log: probes.log,
});
probes.get("/health", async () => ({ status: "alive" }));
probes.get("/ready", async (_req, reply) => {
  const state = worker.status();
  return reply.code(state.ready ? 200 : 503).send(state);
});

let draining = false;
async function shutdown() {
  if (draining) return;
  draining = true;
  const deadline = setTimeout(() => {
    probes.log.warn("Drain deadline exceeded, active lease will expire");
    process.exit(1);
  }, config.WORKER_DRAIN_MS);
  try {
    await worker.stop();
    await probes.close();
    await prisma.$disconnect();
  } finally {
    clearTimeout(deadline);
  }
}
await probes.listen({ host: "127.0.0.1", port: config.WORKER_HEALTH_PORT });
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
worker.start();
