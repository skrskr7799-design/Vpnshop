import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { assignmentPanel } from "./remnawave.assignment";
import { RemnawaveClient } from "./remnawave.client";
import { PANEL_USER } from "./remnawave.fixtures";

it("uses the pinned routes and sanitized failures against an isolated HTTP server", async () => {
  let user = { ...PANEL_USER, description: "vpnshop:staging-http-test:marker" };
  const calls: string[] = [];
  let behavior: "normal" | "timeout" | "proxy404" | "redirect" | "oversize" = "normal";
  const send = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const server = createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (behavior === "timeout") return; // The client supplies the deadline.
    if (behavior === "proxy404") return send(res, 404, { message: "outbound-token" });
    if (behavior === "redirect") return res.writeHead(302, { location: "/unexpected" }).end();
    if (behavior === "oversize") return send(res, 200, { padding: "x".repeat(300_000) });
    if (req.headers.authorization !== "Bearer outbound-token") return send(res, 403, {});
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.method === "POST" && req.url?.endsWith("/disable")) user.status = "DISABLED";
    else if (req.method === "POST" && req.url?.endsWith("/enable")) user.status = "ACTIVE";
    else if (raw) {
      const input = JSON.parse(raw);
      user = { ...user, ...input, activeInternalSquads: input.activeInternalSquads.map((uuid: string) => ({ uuid, name: "Fixture" })) };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ response: user }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new RemnawaveClient({ baseUrl: origin, token: "outbound-token", readRetries: 0, strictErrors: true, timeoutMs: 200 });
  const panel = assignmentPanel(client, { instance: "staging-http-test", origin, linkOrigin: "https://panel.example.com", timeoutMs: 200 });
  try {
    const profile = { expiresAt: new Date(PANEL_USER.expireAt), deviceLimit: 3, squads: [PANEL_USER.activeInternalSquads[0]!.uuid] };
    await panel.createUser(PANEL_USER.username, user.description, profile);
    expect(await panel.findUser(PANEL_USER.username)).toMatchObject({ marker: user.description });
    await panel.updateAbsoluteProfile(7, profile);
    await panel.disableUser(7);
    expect((await panel.readBack(7))?.status).toBe("DISABLED");
    await panel.enableUser(7);
    expect((await panel.getSubscriptionLink(7))?.url).toBe(PANEL_USER.subscriptionUrl);
    expect(calls).toEqual([
      "POST /api/users/", `GET /api/users/by-username/${PANEL_USER.username}`, "PATCH /api/users/",
      "POST /api/users/7/actions/disable", "GET /api/users/7", "POST /api/users/7/actions/enable", "GET /api/users/7",
    ]);
    behavior = "proxy404";
    await expect(panel.findUser(PANEL_USER.username)).rejects.toMatchObject({ message: "Remnawave returned 404" });
    behavior = "timeout";
    await expect(panel.updateAbsoluteProfile(7, profile)).rejects.toMatchObject({ kind: "unavailable" });
    behavior = "redirect";
    await expect(panel.readBack(7)).rejects.toMatchObject({ kind: "unavailable" });
    expect(calls).not.toContain("GET /unexpected");
    behavior = "oversize";
    await expect(panel.readBack(7)).rejects.toMatchObject({ kind: "invalid_response" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
