import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createOrder, createUser } from "../../test/factories";
import { buildTestAdminApp, createEnrolledAdmin } from "../admin/admin.test-helpers";
import { createSession } from "../auth/session.service";

let web: FastifyInstance;
let admin: FastifyInstance;
beforeEach(async () => {
  await resetDatabase();
  web = await buildApp();
  admin = await buildTestAdminApp();
});
afterEach(async () => { await Promise.all([web.close(), admin.close()]); });

const cases = "/api/me/support/cases";
const staffCases = "/api/support/cases";
async function owner() {
  const user = await createUser();
  const session = await createSession(user, {});
  return {
    user, token: session.accessToken,
    get: (url: string) => web.inject({ url, cookies: { vpn_at: session.accessToken } }),
    post: (url: string, payload: object, key = randomUUID()) => web.inject({
      method: "POST", url, payload, cookies: { vpn_at: session.accessToken },
      headers: { origin: env.WEB_ORIGIN, "idempotency-key": key },
    }),
  };
}

it("enforces BOLA and a database-order owner constraint, including creation races", async () => {
  const first = await owner();
  const other = await owner();
  const order = await createOrder(first.user.id);
  const body = { category: "PAYMENT", orderId: order.id, message: "Проверка заказа" };
  expect((await other.post(cases, body)).statusCode).toBe(404);
  await expect(prisma.supportCase.create({ data: {
    orderId: order.id, userId: other.user.id, category: "PAYMENT", requestKeyHash: randomUUID(), fingerprint: "invalid",
  } })).rejects.toMatchObject({ code: "P2003" });
  const key = randomUUID();
  const responses = await Promise.all([first.post(cases, body, key), first.post(cases, body, key)]);
  expect(responses.map(r => r.statusCode)).toEqual([201, 201]);
  const id = responses[0]!.json().case.id;
  expect(responses[1]!.json().case.id).toBe(id);
  expect(await prisma.supportMessage.count()).toBe(1);
  expect((await first.post(cases, { ...body, message: "Другая тема" }, key)).statusCode).toBe(409);

  expect((await other.get(cases)).json().items).toEqual([]);
  expect((await other.get(`${cases}/${id}`)).statusCode).toBe(404);
  expect((await other.post(`${cases}/${id}/messages`, { message: "Чужая заявка" })).statusCode).toBe(404);
  expect((await web.inject({ url: cases })).statusCode).toBe(401);
  expect((await first.get(cases)).headers["cache-control"]).toBe("private, no-store");
});

it("serializes duplicate messages, rejects oversize text and returns plain text with safe fields", async () => {
  const member = await owner();
  const created = await member.post(cases, { category: "OTHER", message: "Помощь" });
  expect(created.statusCode).toBe(201);
  const url = `${cases}/${created.json().case.id}`;
  const badText = await member.post(url + "/messages", { message: "x".repeat(2001) });
  expect(badText.statusCode).toBe(400);
  const key = randomUUID();
  const message = { message: "<img src=x onerror=alert(1)>" };
  const edits = await Promise.all([member.post(url + "/messages", message, key), member.post(url + "/messages", message, key)]);
  expect(edits.map(edit => edit.statusCode)).toEqual([201, 201]);
  expect(edits[0]!.json().message.id).toBe(edits[1]!.json().message.id);
  const thread = (await member.get(url)).json();
  expect(thread.messages.items).toHaveLength(2);
  expect(thread.messages.items.find((m: { text: string }) => m.text === message.message)).toBeTruthy();
  expect(Object.keys(thread.messages.items[0]).sort()).toEqual(["author", "createdAt", "id", "text"]);
  expect(Object.keys(thread.case).sort()).toEqual(["category", "createdAt", "id", "orderId", "status", "updatedAt"]);
});

it("limits the staff contract, atomically audits actions and preserves status transitions", async () => {
  const member = await owner();
  const support = await createEnrolledAdmin("help@example.com", "SUPPORT");
  const operator = await createEnrolledAdmin("case-admin@example.com");
  const created = await member.post(cases, { category: "DELIVERY", message: "Жду выдачи" });
  const { id, updatedAt } = created.json().case;
  const url = `${staffCases}/${id}`;
  expect((await web.inject({ url, cookies: { vpn_at: member.token } })).statusCode).toBe(404);
  expect((await admin.inject({ url, cookies: { vpn_at: member.token } })).statusCode).toBe(401);
  expect((await admin.inject({ url, cookies: { vpn_admin: support.sessionToken } })).json().case.userId).toBe(member.user.id);
  const action = (status: string, expectedUpdatedAt: string, key: string, publicReply?: string, token = operator.sessionToken) => admin.inject({
    url: url + "/actions", method: "POST", cookies: { vpn_admin: token },
    headers: { origin: env.ADMIN_ORIGIN, "idempotency-key": key },
    payload: { status, reason: "Требуется уточнение", expectedUpdatedAt, publicReply },
  });
  const key = randomUUID();
  expect((await action("WAITING_CUSTOMER", updatedAt, key, undefined, support.sessionToken)).statusCode).toBe(403);
  const wait = await action("WAITING_CUSTOMER", updatedAt, key, "Уточните время");
  expect(wait.statusCode).toBe(200);
  expect((await action("WAITING_CUSTOMER", updatedAt, key, "Уточните время")).json().commandId).toBe(wait.json().commandId);
  expect(await prisma.auditLog.count({ where: { actorId: operator.userId, action: "support.case.action" } })).toBe(1);
  expect((await action("RESOLVED", updatedAt, randomUUID())).statusCode).toBe(409);
  const publicUrl = `${cases}/${id}`;
  const msgKey = randomUUID();
  const reply = await member.post(publicUrl + "/messages", { message: "Сегодня" }, msgKey);
  expect(reply.statusCode).toBe(201);
  expect(reply.json().case.status).toBe("OPEN");
  expect((await action("RESOLVED", reply.json().case.updatedAt, randomUUID())).statusCode).toBe(200);
  expect((await member.post(publicUrl + "/messages", { message: "Сегодня" }, msgKey)).statusCode).toBe(201);
  expect((await member.post(publicUrl + "/messages", { message: "Позже" })).json().error.code).toBe("CASE_RESOLVED");
  const details = (await member.get(publicUrl)).json();
  expect(details.history.items.map((e: { status: string }) => e.status))
    .toEqual(["RESOLVED", "OPEN", "WAITING_CUSTOMER", "OPEN"]);
  expect(details.messages.items).toHaveLength(3);
  expect(JSON.stringify(details)).not.toContain("Требуется уточнение");
  expect(JSON.stringify(details)).not.toContain(support.userId);
});
