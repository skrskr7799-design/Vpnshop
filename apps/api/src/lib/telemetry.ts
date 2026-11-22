import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

const buckets = [0.05, 0.1, 0.25, 0.5, 1, 2, 5];
type Histogram = { counts: number[]; observations: number; total: number };
const jsonLabel = (value: string) => JSON.stringify(value);
const metricLabel = (value: string | undefined, fallback: string) => value && /^[a-zA-Z0-9./:@_-]{1,240}$/.test(value) ? value : fallback;

export function serviceLogger(service: string) {
  return {
    level: process.env.NODE_ENV === "test" ? "silent" : "info",
    base: { service, environment: metricLabel(process.env.NODE_ENV, "development"), release: metricLabel(process.env.RELEASE_ID, "local") },
    timestamp: () => ',"timestamp":' + JSON.stringify(new Date().toISOString()),
  } as const;
}

export const telemetryRequestId = () => randomUUID();
const category = (route: string) => route.startsWith("/webhooks/") ? "webhook"
  : route.includes("/auth/") || route.endsWith("/me") ? "identity"
  : route.includes("/health") || route.includes("/ready") ? "probe" : "api";

export function addHttpTelemetry(app: FastifyInstance) {
  const requests = new Map<string, number>();
  const histogram = new Map<string, Histogram>();
  let persistenceFailures = 0;
  let webhookRequests = 0;
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    const kind = category(route);
    const result = reply.statusCode >= 500 ? "5xx" : reply.statusCode >= 400 ? "4xx" : "ok";
    const correlation = req.headers["x-request-id"];
    const correlationId = typeof correlation === "string" && /^[a-f0-9]{32}$/.test(correlation) ? correlation : req.id;
    const duration = reply.elapsedTime / 1000;
    const method = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"].includes(req.method) ? req.method : "other";
    const base = 'route=' + jsonLabel(route) + ',method=' + jsonLabel(method);
    const key = base + ',result=' + jsonLabel(result);
    requests.set(key, (requests.get(key) ?? 0) + 1);
    const stats = histogram.get(base) ?? { counts: buckets.map(() => 0), observations: 0, total: 0 };
    stats.observations++;
    stats.total += duration;
    buckets.forEach((threshold, index) => { if (duration <= threshold) stats.counts[index]!++; });
    histogram.set(base, stats);
    if (kind === "webhook" && reply.statusCode !== 404 && reply.statusCode !== 401 && reply.statusCode !== 403) {
      webhookRequests++;
      if (result === "5xx") persistenceFailures++;
    }
    if (kind !== "probe" || result !== "ok") {
      app.log.info({ requestId: req.id, correlationId, route, operation: kind, durationMs: reply.elapsedTime,
        result, status: reply.statusCode, reasonCode: result === "5xx" ? "SERVER_ERROR" : result === "4xx" ? "REQUEST_REJECTED" : "OK" });
    }
  });
  return () => [
    "# TYPE mzt_http_requests_total counter",
    ...Array.from(requests, ([key, value]) => `mzt_http_requests_total{${key}} ${value}`),
    "# TYPE mzt_http_duration_seconds histogram",
    ...Array.from(histogram, ([key, value]) => [
      ...buckets.map((bound, index) => `mzt_http_duration_seconds_bucket{${key},le="${bound}"} ${value.counts[index]}`),
      `mzt_http_duration_seconds_bucket{${key},le="+Inf"} ${value.observations}`,
      `mzt_http_duration_seconds_count{${key}} ${value.observations}`,
      `mzt_http_duration_seconds_sum{${key}} ${value.total}`,
    ]).flat(),
    "# TYPE mzt_webhook_requests_total counter",
    `mzt_webhook_requests_total ${webhookRequests}`,
    "# TYPE mzt_webhook_persistence_failures_total counter",
    `mzt_webhook_persistence_failures_total ${persistenceFailures}`,
  ].join("\n") + "\n";
}

export async function startMetrics(read: () => string | Promise<string>) {
  const host = process.env.METRICS_HOST;
  if (!host) return;
  if (!/^172\.30\.75\.(1[0-6])$/.test(host)) throw new Error("Metrics must bind to the monitoring network");
  const metrics = Fastify({ logger: false, disableRequestLogging: true });
  metrics.get("/metrics", async (_req, reply) => reply.type("text/plain; version=0.0.4; charset=utf-8").send(await read()));
  await metrics.listen({ host, port: 9100 });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void metrics.close(); });
}
