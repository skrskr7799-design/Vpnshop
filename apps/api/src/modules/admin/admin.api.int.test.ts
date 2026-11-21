import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createJob, createOrder, createUser } from "../../test/factories";
import { buildAdminApp } from "./admin-app";
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

const auditRows = (action?: string) =>
  prisma.auditLog.findMany({ where: action ? { action } : {}, orderBy: { createdAt: "asc" } });
const newPlan = (over: object = {}) =>
  api.post("/api/plans", { code: "starter", name: "Стартовый", deviceLimit: 5, ...over });

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
    for (const url of ["/api/plans", "/api/dashboard", "/api/audit", "/api/jobs"]) {
      expect((await publicApp.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
    await publicApp.close();
  });
});

describe("права доступа", () => {
  it("SUPPORT видит тарифы, задачи и дашборд, но не журнал и ничего не меняет", async () => {
    expect((await supportApi.get("/api/plans")).statusCode).toBe(200);
    expect((await supportApi.get("/api/jobs")).statusCode).toBe(200);
    expect((await supportApi.get("/api/dashboard")).statusCode).toBe(200);
    expect((await supportApi.get("/api/audit")).statusCode).toBe(403);

    const created = (await newPlan()).json().plan;
    const forbidden = [
      await supportApi.post("/api/plans", { code: "x1", name: "X", deviceLimit: 1 }),
      await supportApi.patch(`/api/plans/${created.id}`, { name: "Взлом" }),
      await supportApi.put(`/api/plans/${created.id}/prices`, { durationMonths: 1, currency: "RUB", amount: 1 }),
      await supportApi.delete(`/api/plans/${created.id}`),
      await supportApi.post(`/api/jobs/${created.id}/requeue`),
    ];
    for (const res of forbidden) expect(res.statusCode).toBe(403);
    expect((await prisma.plan.findUniqueOrThrow({ where: { id: created.id } })).name).toBe("Стартовый");
  });

  it("понижение роли действует на уже открытую сессию сразу", async () => {
    expect((await api.get("/api/audit")).statusCode).toBe(200);
    await prisma.user.update({ where: { id: admin.userId }, data: { role: "SUPPORT" } });
    expect((await api.get("/api/audit")).statusCode).toBe(403);
    expect((await api.post("/api/plans", { code: "x1", name: "X", deviceLimit: 1 })).statusCode).toBe(403);
  });
});

describe("тарифы", () => {
  it("создание: 201, запись в журнале с автором и IP", async () => {
    const res = await newPlan({ sortOrder: 10 });
    expect(res.statusCode).toBe(201);
    expect(res.json().plan).toMatchObject({ code: "starter", deviceLimit: 5, isActive: true, sortOrder: 10 });

    const [entry] = await auditRows("plan.create");
    expect(entry).toMatchObject({ actorId: admin.userId, entity: "plan", entityId: res.json().plan.id });
    expect(entry!.ip).toBeTruthy();
  });

  it("дубль кода: 409 и без записи в журнале; кривые данные: 400 с описанием", async () => {
    await newPlan();
    const dup = await newPlan({ name: "Другой" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CODE_TAKEN");
    expect(await auditRows("plan.create")).toHaveLength(1);

    for (const bad of [{ code: "Bad Code" }, { deviceLimit: 0 }, { deviceLimit: 5.5 }, { name: "   " }, { code: "a" }]) {
      const res = await newPlan({ code: "ok-code", ...bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("изменение: в журнал попадают только изменённые поля «было → стало»", async () => {
    const id = (await newPlan()).json().plan.id;
    const res = await api.patch(`/api/plans/${id}`, { name: "Новый", deviceLimit: 7 });
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toMatchObject({ name: "Новый", deviceLimit: 7 });

    const [entry] = await auditRows("plan.update");
    expect(entry!.data).toEqual({ name: { from: "Стартовый", to: "Новый" }, deviceLimit: { from: 5, to: 7 } });

    expect((await api.patch(`/api/plans/${id}`, {})).statusCode).toBe(400); // нет изменений
    expect((await api.patch(`/api/plans/${id}`, { code: "hack" })).statusCode).toBe(400); // код менять нельзя
    expect((await api.patch("/api/plans/not-a-uuid", { name: "x" })).statusCode).toBe(400);
    expect((await api.patch("/api/plans/00000000-0000-4000-8000-000000000000", { name: "x" })).statusCode).toBe(404);
  });

  it("правка одного поля не трогает остальные: отключённый тариф остаётся отключённым", async () => {
    const id = (await newPlan({ sortOrder: 40, isActive: false })).json().plan.id;
    const res = await api.patch(`/api/plans/${id}`, { name: "Переименован" });
    expect(res.json().plan).toMatchObject({ name: "Переименован", isActive: false, sortOrder: 40 });
    expect((await auditRows("plan.update"))[0]!.data).toEqual({ name: { from: "Стартовый", to: "Переименован" } });
  });

  it("цены: создание и обновление по ключу «срок + валюта», удаление, проверка данных", async () => {
    const id = (await newPlan()).json().plan.id;
    const put = (body: object) => api.put(`/api/plans/${id}/prices`, body);

    expect((await put({ durationMonths: 1, currency: "RUB", amount: 19900 })).statusCode).toBe(200);
    expect((await put({ durationMonths: 1, currency: "RUB", amount: 24900 })).statusCode).toBe(200); // обновление
    await put({ durationMonths: 3, currency: "RUB", amount: 54900 });
    await put({ durationMonths: 1, currency: "XTR", amount: 150 });

    const plans = (await api.get("/api/plans")).json().plans;
    expect(plans[0].prices.map((p: { durationMonths: number; currency: string; amount: number }) => `${p.durationMonths}:${p.currency}:${p.amount}`)).toEqual([
      "1:RUB:24900",
      "1:XTR:150",
      "3:RUB:54900",
    ]);

    const upserts = await auditRows("plan.price.upsert");
    expect(upserts[1]!.data).toMatchObject({ durationMonths: 1, currency: "RUB", from: 19900, to: 24900 });

    for (const bad of [{ amount: 0 }, { durationMonths: 0 }, { durationMonths: 99 }, { currency: "EUR" }, { amount: 1.5 }]) {
      expect((await put({ durationMonths: 1, currency: "RUB", amount: 100, ...bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await api.put("/api/plans/00000000-0000-4000-8000-000000000000/prices", { durationMonths: 1, currency: "RUB", amount: 1 })).statusCode).toBe(404);

    const priceId = plans[0].prices[0].id;
    expect((await api.delete(`/api/plans/${id}/prices/${priceId}`)).statusCode).toBe(204);
    expect((await api.delete(`/api/plans/${id}/prices/${priceId}`)).statusCode).toBe(404);
    expect(await auditRows("plan.price.delete")).toHaveLength(1);
  });

  it("удалить можно только тариф без заказов, иначе 409 (его можно отключить)", async () => {
    const used = (await newPlan({ code: "used" })).json().plan;
    const unused = (await newPlan({ code: "unused" })).json().plan;
    await prisma.order.create({
      data: { userId: (await createUser()).id, planId: used.id, durationMonths: 1, deviceLimit: 5, currency: "RUB", amount: 100, expiresAt: new Date() },
    });

    const blocked = await api.delete(`/api/plans/${used.id}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("PLAN_HAS_ORDERS");
    expect(await prisma.plan.count({ where: { id: used.id } })).toBe(1);

    await api.put(`/api/plans/${unused.id}/prices`, { durationMonths: 1, currency: "RUB", amount: 100 });
    expect((await api.delete(`/api/plans/${unused.id}`)).statusCode).toBe(204);
    expect(await prisma.planPrice.count({ where: { planId: unused.id } })).toBe(0); // цены удалились каскадом
    expect(await auditRows("plan.delete")).toHaveLength(1);

    // а отключить можно в любой момент
    expect((await api.patch(`/api/plans/${used.id}`, { isActive: false })).json().plan.isActive).toBe(false);
  });
});

describe("задачи выдачи", () => {
  async function seedJobs() {
    const jobs: Record<string, string> = {};
    for (const [i, status] of (["DONE", "FAILED", "PENDING"] as const).entries()) {
      const user = await createUser({ email: `buyer${i}@example.com` });
      const job = await createJob((await createOrder(user.id)).id, new Date(Date.now() - (3 - i) * 1000));
      await prisma.fulfillmentJob.update({ where: { id: job.id }, data: { status, lastError: status === "FAILED" ? "panel down" : null } });
      jobs[status] = job.id;
    }
    return jobs;
  }

  it("список с фильтром, пагинацией и данными покупателя", async () => {
    await seedJobs();
    const all = (await api.get("/api/jobs")).json();
    expect(all.total).toBe(3);
    expect(all.items[0].order.user.email).toMatch(/^buyer\d@example.com$/);
    expect(all.items[0].createdAt >= all.items[2].createdAt).toBe(true); // новые сверху

    const failed = (await api.get("/api/jobs?status=FAILED")).json();
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0].lastError).toBe("panel down");

    const page2 = (await api.get("/api/jobs?pageSize=2&page=2")).json();
    expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(1);

    expect((await api.get("/api/jobs?status=BOGUS")).statusCode).toBe(400);
    expect((await api.get("/api/jobs?pageSize=1000")).statusCode).toBe(400);
  });

  it("повтор упавшей задачи: 204, задача снова в очереди, запись в журнале; чужие статусы: 409", async () => {
    const jobs = await seedJobs();
    expect((await api.post(`/api/jobs/${jobs.FAILED}/requeue`)).statusCode).toBe(204);
    expect(await prisma.fulfillmentJob.findUniqueOrThrow({ where: { id: jobs.FAILED } })).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(await auditRows("job.requeue")).toHaveLength(1);

    const again = await api.post(`/api/jobs/${jobs.FAILED}/requeue`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("NOT_FAILED");
    expect((await api.post(`/api/jobs/${jobs.DONE}/requeue`)).statusCode).toBe(409);
    expect(await auditRows("job.requeue")).toHaveLength(1); // отказы в журнал не попадают
  });
});

describe("журнал действий", () => {
  it("фильтр по префиксу действия, автор с email, пагинация", async () => {
    const id = (await newPlan()).json().plan.id;
    await api.patch(`/api/plans/${id}`, { name: "Новый" });
    await api.put(`/api/plans/${id}/prices`, { durationMonths: 1, currency: "RUB", amount: 100 });

    const plans = (await api.get("/api/audit?action=plan.")).json();
    expect(plans.total).toBe(3);
    expect(plans.items.every((i: { action: string }) => i.action.startsWith("plan."))).toBe(true);
    expect(plans.items[0].actorEmail).toBe("root@example.com");

    const logins = (await api.get("/api/audit?action=admin.login")).json();
    expect(logins.items.length).toBeGreaterThan(0);

    const byActor = (await api.get(`/api/audit?actorId=${support.userId}`)).json();
    expect(byActor.items.every((i: { actorId: string }) => i.actorId === support.userId)).toBe(true);

    const small = (await api.get("/api/audit?pageSize=2&page=2")).json();
    expect(small.items).toHaveLength(2);
    expect((await api.get("/api/audit?actorId=nope")).statusCode).toBe(400);
  });
});

describe("дашборд", () => {
  it("считает пользователей, заказы, выручку по валютам, задачи и состояние панели", async () => {
    const buyer = await createUser();
    await createOrder(buyer.id, { status: "PAID" });
    await createOrder(buyer.id, { status: "FULFILLED" });
    await createOrder(buyer.id, { status: "PENDING" });
    const failedJob = await createJob((await createOrder(buyer.id, { status: "PAID" })).id);
    await prisma.fulfillmentJob.update({ where: { id: failedJob.id }, data: { status: "FAILED" } });

    const data = (await api.get("/api/dashboard")).json();
    expect(data.users.total).toBe(3); // покупатель + два админа
    expect(data.users.last7d).toBe(3);
    expect(data.orders).toMatchObject({ PENDING: 1, PAID: 2, FULFILLED: 1, REFUNDED: 0 });
    // оплаченные и выданные: 3 заказа по 100 руб. (10 000 копеек), ожидающий не считается
    expect(data.revenue.allTime).toEqual([{ currency: "RUB", amount: 30_000, orders: 3 }]);
    expect(data.revenue.last30d).toEqual([{ currency: "RUB", amount: 30_000, orders: 3 }]);
    expect(data.jobs).toMatchObject({ FAILED: 1, PENDING: 0, DONE: 0, RUNNING: 0 });
    expect(data.panel).toEqual({ ok: true, version: "3.4.9" });
  });

  it("недоступная панель не ломает дашборд", async () => {
    const down = await buildAdminApp({ panel: { getMetadata: async () => Promise.reject(new Error("down")) }, logger: false });
    const res = await as(down, admin.sessionToken).get("/api/dashboard");
    expect(res.statusCode).toBe(200);
    expect(res.json().panel).toEqual({ ok: false, version: null });
    await down.close();
  });
});

void env;
