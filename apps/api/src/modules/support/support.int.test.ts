import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildApp } from "../../app";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createOrder, createUser } from "../../test/factories";
import { buildTestAdminApp, createEnrolledAdmin, as } from "../admin/admin.test-helpers";
import { deliverNext } from "../mail/outbox";
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
  expect((await other.post(`${cases}/${id}/status`, { action: "close" })).statusCode).toBe(404);
  expect((await other.post(`${cases}/${id}/read`, { through: new Date().toISOString() })).statusCode).toBe(404);
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
  expect(Object.keys(thread.case).sort()).toEqual(["category", "createdAt", "id", "orderId", "status", "subject", "unread", "updatedAt"]);
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
  const action = (status: string, expectedUpdatedAt: string, key: string, publicReply?: string, token = operator.sessionToken) =>
    as(admin, token).command("support.action", id, expectedUpdatedAt, { status, publicReply }, { key, reason: "Требуется уточнение" });
  const key = randomUUID();
  expect((await action("WAITING_CUSTOMER", updatedAt, key, undefined, support.sessionToken)).statusCode).toBe(403);
  const wait = await action("WAITING_CUSTOMER", updatedAt, key, "Уточните время");
  expect(wait.statusCode).toBe(200);
  expect((await action("WAITING_CUSTOMER", updatedAt, key, "Уточните время")).json().commandId).toBe(wait.json().commandId);
  expect(await prisma.auditLog.count({ where: { actorId: operator.userId, action: "support.action" } })).toBe(1);
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

it("keeps separate read positions and never clears an unseen concurrent message", async () => {
  const member = await owner();
  const first = await createEnrolledAdmin("first-reader@example.com", "SUPPORT");
  const second = await createEnrolledAdmin("second-reader@example.com", "SUPPORT");
  const created = await member.post(cases, { category: "TECHNICAL", subject: "Проверка подключения", message: "Первое" });
  const id = created.json().case.id;
  const staffUrl = `${staffCases}/${id}`;
  const publicUrl = `${cases}/${id}`;
  async function read(token: string) {
    return (await admin.inject({ url: staffUrl, cookies: { vpn_admin: token } })).json();
  }
  const snapshot = await read(first.sessionToken);
  expect(snapshot.case.unread).toBe(1);
  expect((await read(first.sessionToken)).case.unread).toBe(1);
  expect((await member.post(publicUrl + "/messages", { message: "Ещё одно" })).statusCode).toBe(201);
  const marked = await admin.inject({ method: "POST", url: staffUrl + "/read", cookies: { vpn_admin: first.sessionToken },
    headers: { origin: env.ADMIN_ORIGIN }, payload: { through: snapshot.readThrough } });
  expect(marked.statusCode).toBe(204);
  const data = await read(first.sessionToken);
  expect(data.case.unread).toBe(1);
  expect((await read(second.sessionToken)).case.unread).toBe(2);
  const replied = await admin.inject({ method: "POST", url: `/api/commands/support.reply/${id}`,
    cookies: { vpn_admin: first.sessionToken }, headers: { origin: env.ADMIN_ORIGIN, "idempotency-key": randomUUID() },
    payload: { expectedVersion: data.case.updatedAt, command: { publicReply: "Ответ сотрудника" } } });
  expect(replied.statusCode).toBe(200);
  expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "support.reply" } })).reason).toBeNull();
  const customer = (await member.get(publicUrl)).json();
  expect(customer.case).toMatchObject({ subject: "Проверка подключения", status: "WAITING_CUSTOMER", unread: 1 });
  expect((await member.post(publicUrl + "/read", { through: customer.readThrough })).statusCode).toBe(204);
  expect((await member.get(publicUrl)).json().case.unread).toBe(0);
  const close = await member.post(publicUrl + "/status", { action: "close" });
  expect(close.json().case.status).toBe("CLOSED");
  expect((await member.post(publicUrl + "/status", { action: "reopen" })).statusCode).toBe(409);
  expect((await member.post(publicUrl + "/messages", { message: "Закрыто" })).statusCode).toBe(409);
});

it("validates assignments, isolates internal triage and surfaces inactive assignments in the unassigned queue", async () => {
  const member = await owner();
  const operator = await createEnrolledAdmin("assignment-admin@example.com");
  const agent = await createEnrolledAdmin("assignment-support@example.com", "SUPPORT");
  const { id, updatedAt } = (await member.post(cases, { category: "ACCOUNT", subject: "Профиль", message: "Помогите" })).json().case;
  const command = as(admin, operator.sessionToken);
  const mutate = (version: string, input: object) => command.command("support.action", id, version, input,
    { key: randomUUID(), reason: "Распределение обращения" });
  expect((await mutate(updatedAt, { assigneeId: member.user.id })).statusCode).toBe(409);
  const assigned = await mutate(updatedAt, { assigneeId: agent.userId, priority: "HIGH" });
  expect(assigned.statusCode).toBe(200);
  const get = (filter: string) => admin.inject({ url: staffCases + filter, cookies: { vpn_admin: operator.sessionToken } });
  expect((await get("?search=" + encodeURIComponent("профиль") + "&priority=HIGH&assigneeId=" + agent.userId)).json().items[0])
    .toMatchObject({ id, priority: "HIGH", assigneeId: agent.userId });
  const publicDetail = (await member.get(cases + "/" + id)).json();
  expect(publicDetail.case.unread).toBe(0);
  expect(publicDetail.history.items).toHaveLength(1);
  expect(JSON.stringify(publicDetail)).not.toContain(agent.userId);
  await prisma.staffCredential.update({ where: { userId: agent.userId }, data: { deactivatedAt: new Date() } });
  expect((await get("?assigneeId=unassigned")).json().items[0]).toMatchObject({ id, assigneeId: null, priority: "HIGH" });
  const version = assigned.json().result.case.updatedAt;
  const resolved = await mutate(version, { status: "RESOLVED" });
  expect(resolved.statusCode).toBe(200);
  const reopened = await member.post(cases + "/" + id + "/status", { action: "reopen" });
  expect(reopened.json().case.status).toBe("OPEN");
});

it("commits one optional email job per staff reply and never includes the message", async () => {
  const original = env.MAIL_QUEUE_KEY;
  env.MAIL_QUEUE_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const member = await owner();
    await prisma.user.update({ where: { id: member.user.id }, data: { emailVerifiedAt: new Date() } });
    const operator = await createEnrolledAdmin("notify-support@example.com");
    const { id, updatedAt } = (await member.post(cases, { category: "OTHER", message: "Проверка канала" })).json().case;
    const key = randomUUID();
    const text = "Текст остаётся внутри кабинета";
    const send = () => as(admin, operator.sessionToken).command("support.action", id, updatedAt, { publicReply: text },
      { key, reason: "Ответ о состоянии обращения" });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    expect(await prisma.notificationOutbox.count()).toBe(1);
    expect(await prisma.supportMessage.count({ where: { caseId: id, author: "STAFF" } })).toBe(1);
    expect(await deliverNext(async mail => {
      expect(mail.to).toBe(member.user.email);
      expect(mail.text).not.toContain(text);
      expect(mail.text).toContain("/account/support/" + id);
    })).toBe(true);
    expect(await prisma.notificationOutbox.count()).toBe(0);
  } finally {
    env.MAIL_QUEUE_KEY = original;
  }
});
