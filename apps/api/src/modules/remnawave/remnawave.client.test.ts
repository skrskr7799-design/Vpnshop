import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RemnawaveClient } from "./remnawave.client";
import { RemnawaveError } from "./remnawave.errors";
import { PANEL_USER } from "./remnawave.fixtures";

// Локальный «Remnawave»: записывает запросы и отвечает по заготовке
type Recorded = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
type Reply = { status: number; body?: unknown };

let server: Server;
let baseUrl: string;
let requests: Recorded[] = [];
let replies: Reply[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const reply = replies.shift() ?? { status: 500 };
      res.statusCode = reply.status;
      res.setHeader("Content-Type", "application/json");
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  requests = [];
  replies = [];
});

const make = (extra: Partial<ConstructorParameters<typeof RemnawaveClient>[0]> = {}) =>
  new RemnawaveClient({ baseUrl, token: "secret-token", retryDelayMs: 1, ...extra });

describe("заголовки", () => {
  it("Bearer-токен, без Content-Type на GET и с ним на запросах с телом", async () => {
    replies = [{ status: 200, body: { response: PANEL_USER } }, { status: 200, body: { response: PANEL_USER } }];
    const client = make();
    await client.getUserByUsername("someone");
    await client.updateUser({ id: 7, hwidDeviceLimit: 5 });

    expect(requests[0]!.headers.authorization).toBe("Bearer secret-token");
    expect(requests[0]!.headers["content-type"]).toBeUndefined();
    expect(requests[1]!.headers["content-type"]).toBe("application/json");
    expect(requests[0]!.headers["x-api-key"]).toBeUndefined();
    expect(requests[0]!.headers["x-forwarded-for"]).toBeUndefined();
  });

  it("добавляет X-Api-Key и forwarded-заголовки, когда они включены", async () => {
    replies = [{ status: 200, body: { response: { version: "3.4.9" } } }];
    await make({ apiKey: "caddy-key", trustedProxyHeaders: true }).getMetadata();

    expect(requests[0]!.headers["x-api-key"]).toBe("caddy-key");
    expect(requests[0]!.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(requests[0]!.headers["x-forwarded-proto"]).toBe("https");
  });
});

describe("операции", () => {
  it("getUserByUsername: разбирает пользователя и превращает expireAt в Date", async () => {
    replies = [{ status: 200, body: { response: PANEL_USER } }];
    const user = await make().getUserByUsername("vs_abc");

    expect(requests[0]).toMatchObject({ method: "GET", url: "/api/users/by-username/vs_abc" });
    expect(user).toMatchObject({ id: 7, status: "ACTIVE", subscriptionUrl: PANEL_USER.subscriptionUrl });
    expect(user!.expireAt).toBeInstanceOf(Date);
    expect(user!.expireAt.toISOString()).toBe("2030-01-31T10:00:00.000Z");
  });

  it("getUserByUsername: 404 означает «нет такого пользователя»", async () => {
    replies = [{ status: 404, body: { message: "User not found" } }];
    expect(await make().getUserByUsername("nobody")).toBeNull();
  });

  it("createUser: отправляет ожидаемое тело", async () => {
    replies = [{ status: 201, body: { response: PANEL_USER } }];
    await make().createUser({
      username: "vs_abc",
      expireAt: new Date("2030-01-31T10:00:00.000Z"),
      hwidDeviceLimit: 5,
      activeInternalSquads: ["11111111-1111-4111-8111-111111111111"],
    });

    expect(requests[0]).toMatchObject({ method: "POST", url: "/api/users/" });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      username: "vs_abc",
      status: "ACTIVE",
      expireAt: "2030-01-31T10:00:00.000Z",
      trafficLimitBytes: 0,
      trafficLimitStrategy: "NO_RESET",
      hwidDeviceLimit: 5,
      activeInternalSquads: ["11111111-1111-4111-8111-111111111111"],
    });
  });

  it("updateUser: PATCH с id и только переданными полями", async () => {
    replies = [{ status: 200, body: { response: PANEL_USER } }];
    await make().updateUser({ id: 7, expireAt: new Date("2030-02-28T10:00:00.000Z"), status: "ACTIVE" });

    expect(requests[0]).toMatchObject({ method: "PATCH", url: "/api/users/" });
    expect(JSON.parse(requests[0]!.body)).toEqual({ id: 7, expireAt: "2030-02-28T10:00:00.000Z", status: "ACTIVE" });
  });

  it("listInternalSquads", async () => {
    replies = [
      { status: 200, body: { response: { total: 1, internalSquads: [{ uuid: "u1", name: "Default-Squad", extra: 1 }] } } },
    ];
    expect(await make().listInternalSquads()).toEqual([{ uuid: "u1", name: "Default-Squad" }]);
  });
});

describe("ошибки и повторы", () => {
  it("401 это unauthorized: повтор не поможет, нужен оператор", async () => {
    replies = [{ status: 401, body: { message: "Unauthorized" } }];
    const err = await make().getMetadata().catch((e) => e);
    expect(err).toBeInstanceOf(RemnawaveError);
    expect(err).toMatchObject({ kind: "unauthorized", status: 401, retryable: false, needsOperator: true });
    expect(requests).toHaveLength(1);
  });

  it("GET повторяется при 5xx и в итоге успешен", async () => {
    replies = [{ status: 502 }, { status: 503 }, { status: 200, body: { response: { version: "3.4.9" } } }];
    expect(await make().getMetadata()).toEqual({ version: "3.4.9" });
    expect(requests).toHaveLength(3);
  });

  it("запись НЕ повторяется при 5xx (иначе можно применить действие дважды)", async () => {
    replies = [{ status: 500 }, { status: 200, body: { response: PANEL_USER } }];
    const err = await make().createUser({
      username: "vs_abc",
      expireAt: new Date("2030-01-01T00:00:00.000Z"),
      hwidDeviceLimit: 5,
      activeInternalSquads: [],
    }).catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable", retryable: true });
    expect(requests).toHaveLength(1);
  });

  it("400 это rejected (например, имя занято)", async () => {
    replies = [{ status: 400, body: { message: ["username already exists"] } }];
    const err = await make().updateUser({ id: 1 }).catch((e) => e);
    expect(err).toMatchObject({ kind: "rejected", status: 400 });
    expect(err.message).toContain("username already exists");
  });

  it("недоступный сервер даёт unavailable, а не сырое исключение", async () => {
    const err = await new RemnawaveClient({ baseUrl: "http://127.0.0.1:1", token: "t", retryDelayMs: 1, readRetries: 0 })
      .getMetadata()
      .catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable", retryable: true });
  });

  it("ответ не по схеме даёт invalid_response", async () => {
    replies = [{ status: 200, body: { response: { id: "not-a-number" } } }];
    const err = await make().getUserByUsername("x").catch((e) => e);
    expect(err).toMatchObject({ kind: "invalid_response", needsOperator: true });
  });

  it("токен не попадает в сообщение об ошибке", async () => {
    replies = [{ status: 401 }];
    const err = await make().getMetadata().catch((e) => e);
    expect(err.message).not.toContain("secret-token");
  });
});
