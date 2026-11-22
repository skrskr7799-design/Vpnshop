import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerErrorHandler } from "./error-handler";
import { addHttpTelemetry, serviceLogger, telemetryRequestId } from "./telemetry";

it("emits only route-template telemetry even for handler errors and supplied credentials", async () => {
  const stream = new PassThrough();
  let logs = "";
  stream.on("data", chunk => { logs += chunk.toString(); });
  const app = Fastify({ logger: { ...serviceLogger("synthetic"), stream, level: "info" },
    disableRequestLogging: true, genReqId: telemetryRequestId });
  registerErrorHandler(app);
  const scrape = addHttpTelemetry(app);
  const marker = "MZT-TEST-PRIVATE-MARKER";
  app.post("/webhooks/:channel", async () => { throw new Error(marker); });
  try {
    const result = await app.inject({ method: "POST", url: "/webhooks/" + marker + "?code=" + marker,
      headers: { authorization: "Bearer " + marker, cookie: "secret=" + marker, "x-request-id": marker },
      payload: { password: marker, payload: marker, subscriptionUrl: marker },
    });
    expect(result.statusCode).toBe(500);
    expect(logs).not.toContain(marker);
    expect(scrape()).not.toContain(marker);
    expect(scrape()).toContain('mzt_http_requests_total{route="/webhooks/:channel",method="POST",result="5xx"} 1');
    expect(scrape()).toContain("mzt_webhook_persistence_failures_total 1");
    expect(logs).toContain('"timestamp":');
  } finally { await app.close(); stream.end(); }
});
