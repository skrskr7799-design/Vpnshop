import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createOrder, createUser } from "../../test/factories";
import { buildAdminApp } from "./admin-app";
import { paidOrder, financeFact } from "./admin.fixtures";
import { as, buildTestAdminApp, createEnrolledAdmin, type EnrolledAdmin } from "./admin.test-helpers";

let app: FastifyInstance;
let admin: EnrolledAdmin;
let support: EnrolledAdmin;
let api: ReturnType<typeof as>;
let supportApi: ReturnType<typeof as>;

beforeEach(async () => {
  await resetDatabase();
  app = await buildTestAdminApp();
  admin = await createEnrolledAdmin("root@example.com", "ADMIN");
  support = await createEnrolledAdmin("support@example.com", "SUPPORT");
  api = as(app, admin.sessionToken);
  supportApi = as(app, support.sessionToken);
});
afterEach(() => app.close());

describe("защита периметра", () => {
  it("без сессии все данные закрыты", async () => {
    for (const url of ["/api/me", "/api/plans", "/api/dashboard", "/api/jobs", "/api/audit"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    const forged = await app.inject({ method: "GET", url: "/api/plans", cookies: { vpn_admin: "forged-token" } });
    expect(forged.statusCode).toBe(401);
  });

  it("изменяющий запрос без нужного Origin отклоняется (CSRF)", async () => {
    const cookies = { vpn_admin: admin.sessionToken };
    const payload = { code: "x1", name: "X", deviceLimit: 1 };
    const none = await app.inject({ method: "POST", url: "/api/plans", cookies, payload });
    const evil = await app.inject({ method: "POST", url: "/api/plans", cookies, payload, headers: { origin: "https://evil.example" } });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe("BAD_ORIGIN");
    expect(evil.statusCode).toBe(403);
    expect(await prisma.plan.count()).toBe(0);
    // чтение Origin не требует
    expect((await app.inject({ method: "GET", url: "/api/plans", cookies })).statusCode).toBe(200);
  });

  it("IP вне списка получает 404, как будто админки нет; подделка X-Forwarded-For не помогает", async () => {
    const guarded = await buildTestAdminApp({ allowedCidrs: ["10.0.0.0/8"] });
    const outside = await guarded.inject({ method: "GET", url: "/api/me", remoteAddress: "203.0.113.9" });
    const spoofed = await guarded.inject({
      method: "GET",
      url: "/api/me",
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "10.1.2.3" },
    });
    const inside = await guarded.inject({ method: "GET", url: "/api/me", remoteAddress: "10.1.2.3" });

    expect(outside.statusCode).toBe(404);
    expect(spoofed.statusCode).toBe(404);
    expect(inside.statusCode).toBe(401); // дошли до проверки сессии
    await guarded.close();
  });

  it("публичный API не содержит маршрутов админки", async () => {
    const { buildApp } = await import("../../app");
    const publicApp = await buildApp();
    for (const url of ["/api/dashboard", "/api/audit", "/api/jobs"]) {
      expect((await publicApp.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
    await publicApp.close();
  });
});

it("isolates SUPPORT, masks contacts and excludes finance-only blocks and internal metadata", async () => {
  const customer = await createUser({ email: "secret-customer@example.invalid" });
  const order = await createOrder(customer.id);
  for (const path of ["/api/users", "/api/jobs", "/api/plans", "/api/support/cases", "/api/operations/status"]) {
    expect((await supportApi.get(path)).statusCode).toBe(200);
  }
  const dashboard = (await supportApi.get("/api/dashboard")).json();
  expect(dashboard).not.toHaveProperty("finance");
  expect(dashboard.users.data.total).toBe(1);
  expect((await supportApi.get("/api/users/" + customer.id)).body).not.toContain(customer.email!);
  expect((await supportApi.get("/api/orders/" + order.id)).headers["cache-control"]).toBe("no-store");
  for (const path of ["/api/audit", "/api/staff", "/api/payments/transactions", `/api/orders/${order.id}/finance`]) {
    expect((await supportApi.get(path)).statusCode).toBe(403);
  }
  expect((await supportApi.command("staff.role", admin.userId, 1, { role: "SUPPORT" })).statusCode).toBe(403);
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "SUPPORT" } });
  expect((await api.get("/api/audit")).statusCode).toBe(403);
});

it("paginates 1001 users with timestamp ties, stable cursors and filter isolation", async () => {
  const createdAt = new Date("2026-01-01T00:00:00Z");
  await prisma.user.createMany({ data: Array.from({ length: 1001 }, (_, i) => ({
    email: `row-${i}@example.invalid`, createdAt,
  })) });
  const ids = new Set<string>();
  let cursor: string | null = null;
  do {
    const path: string = "/api/users?limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const response = await api.get(path);
    expect(response.statusCode).toBe(200);
    const page = response.json<{ items: { id: string }[]; nextCursor: string | null }>();
    for (const row of page.items) {
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
    }
    cursor = page.nextCursor;
    if (ids.size === 100) expect((await api.get("/api/users?status=ACTIVE&cursor=" + encodeURIComponent(cursor!))).statusCode).toBe(400);
  } while (cursor);
  expect(ids.size).toBe(1001);
});

it("sums verified CAPTURE, refunds and chargebacks by currency and marks stale/unavailable sources", async () => {
  const buyer = await createUser();
  const legacy = await createOrder(buyer.id, { status: "PAID" });
  const { capture, order } = await paidOrder(buyer.id);
  await financeFact(capture.accountId, "REFUND", 500n, "RUB", capture.movementKey, capture.paymentId!);
  await financeFact(capture.accountId, "CHARGEBACK_DEBIT", 250n, "RUB", capture.movementKey, capture.paymentId!);
  await financeFact(capture.accountId, "CAPTURE", 999n, "USD");
  const old = new Date(Date.now() - 65_000);
  await prisma.workerHeartbeat.create({ data: { id: "expired-fixture", observedAt: old, ready: true } });
  const fixture = await buildAdminApp({ logger: false, panel: { getMetadata: async () => { throw new Error("fixture unavailable"); } } });
  try {
    const response = await as(fixture, admin.sessionToken).get("/api/dashboard");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      orders: { data: { paid: 1 } }, worker: { state: "STALE" }, panel: { state: "UNAVAILABLE", data: null },
      finance: { data: [
        { currency: "RUB", captured: "10000", allocated: "10000", refunded: "500", chargebackDebits: "250", net: "9250" },
        { currency: "USD", captured: "999", allocated: "0", unallocated: "999" },
      ] },
    });
    expect((await api.get("/api/orders/" + legacy.id)).json()).toMatchObject({ allocated: false, delivery: "NOT_REQUESTED" });
    const detail = (await api.get("/api/orders/" + order.id)).json();
    expect(detail).toMatchObject({ allocated: true, allocation: { captureId: capture.id }, period: { id: expect.any(String) }, job: { revision: 1 } });
    expect(JSON.stringify(detail)).not.toMatch(/private-payload|subscriptionUrl|secretEnc/);
  } finally { await fixture.close(); }
});
