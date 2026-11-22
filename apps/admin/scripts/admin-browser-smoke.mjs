// Run with node >=22 and a local Chromium after building @vpn/admin.
// All backend responses are synthetic; the browser uses the real bundled client.
import assert from "node:assert/strict";
import { launchChromium } from "../../../scripts/smoke-chromium.mjs";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const dist = resolve(import.meta.dirname, "../dist");
const profile = await mkdtemp(join(tmpdir(), "mzt-admin-smoke-"));
const now = new Date().toISOString();
let signedIn = false;
let role = "ADMIN";
let commandCalls = 0;
let commandKey;
let commandBody;
const customer = { id: "id-customer", email: "p•••@example.invalid", status: "ACTIVE", createdAt: now };
const plan = { id: "fixture-plan", name: "MZT Standard", code: "standard", revision: 1, deviceLimit: 5, isActive: true };
const ticket = { id: "case-1", category: "DELIVERY", orderId: "order-1", status: "OPEN", updatedAt: now };
const html = '<img src=x onerror="window.adminUnsafe=true">';
const pages = items => ({ items, nextCursor: null });
const block = (data, state = "FRESH") => ({ data, state, observedAt: now });
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (!path.startsWith("/api/")) {
    const filename = path.startsWith("/assets/") ? join(dist, path) : join(dist, "index.html");
    try {
      res.setHeader("Content-Type", mime[extname(filename)] ?? "application/octet-stream");
      res.end(await readFile(filename));
    } catch { res.writeHead(404).end(); }
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const json = (body, status = 200) => res.writeHead(status).end(JSON.stringify(body));
  if (path === "/api/auth/login") {
    if (input.password !== "local-test-password") return json({ error: { code: "INVALID_CREDENTIALS" } }, 401);
    role = input.email.startsWith("support") ? "SUPPORT" : "ADMIN";
    return json({ step: "verify_2fa", stageToken: "synthetic-only" });
  }
  if (path === "/api/auth/2fa/verify") {
    if (input.code !== "123456") return json({ error: { code: "INVALID_CODE" } }, 401);
    signedIn = true;
    return json({});
  }
  if (!signedIn) return json({ error: { code: "UNAUTHENTICATED" } }, 401);
  if (path === "/api/auth/logout") { signedIn = false; return res.writeHead(204).end(); }
  const admin = role === "ADMIN";
  const permissions = ["dashboard:read", "users:read", "orders:read", "plans:read", "support:read", "ops:read", "jobs:read",
    ...(admin ? ["plans:write", "finance:read", "audit:read", "staff:read", "support:write"] : [])];
  if (path === "/api/me") return json({ user: { id: role, email: role.toLowerCase() + "@example.invalid", role }, permissions });
  if (path === "/api/dashboard") return json({ asOf: now, users: block({ total: 18 }), panel: block(null, "UNAVAILABLE"),
    worker: block(null, "STALE"), alerts: [], ...(admin ? { finance: block([{ currency: "RUB", captured: "100" }]) } : {}) });
  if (path === "/api/users") return json(pages([customer]));
  if (path === "/api/users/id-customer") return json({ ...customer, right: "ACTIVE", subscription: null, version: now });
  if (path === "/api/plans") return json(pages([plan]));
  if (path === "/api/plans/fixture-plan/versions") return json({ plan, ...pages([]) });
  if (path === "/api/support/cases") return json(pages([ticket]));
  if (path === "/api/support/cases/case-1") return json({ case: ticket, messages: pages([{ id: "msg", author: "CUSTOMER", text: html, createdAt: now }]),
    history: pages([]) });
  if (path === "/api/auth/step-up") {
    if (input.code !== "123456" || input.permission !== "plans:write" || !admin) return json({ error: { code: "FORBIDDEN" } }, 403);
    return json({ confirmationId: "confirmation-test" });
  }
  if (path.startsWith("/api/commands/")) {
    commandCalls++;
    if (commandCalls === 1) {
      commandKey = req.headers["idempotency-key"];
      commandBody = input;
      return json({ error: { code: "UNAVAILABLE" } }, 503);
    }
    assert.equal(req.headers["idempotency-key"], commandKey);
    assert.deepEqual(input, commandBody);
    return json({ commandId: "persisted-command", result: { id: "offer-1" } });
  }
  return json({ error: { code: "NOT_FOUND" } }, 404);
});
let chromium;
try {
  await readFile(join(dist, "index.html"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  chromium = await launchChromium(profile);
  const { ws } = chromium;
  let sequence = 0;
  const calls = new Map();
  const requests = [];
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent") requests.push(message.params.request.url);
    const call = calls.get(message.id);
    if (call) { calls.delete(message.id); call(message); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    calls.set(id, response => response.error ? reject(new Error(response.error.message)) : resolve(response.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description);
    return response.result.value;
  };
  async function until(expression) {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error("Missing expected UI state: " + expression);
  }
  const text = value => "Boolean(document.body?.innerText.includes(" + JSON.stringify(value) + "))";
  const click = value => evaluate(`[...document.querySelectorAll("a,button,summary")].find(node => node.textContent.trim() === ${JSON.stringify(value)} && node.checkVisibility()).click()`);
  const fill = (name, value) => evaluate(`[...document.querySelectorAll('[name=' + ${JSON.stringify(name)} + ']')].find(node => node.checkVisibility()).value = ${JSON.stringify(value)}`);
  const fit = () => until("Boolean(document.documentElement && document.documentElement.scrollWidth <= innerWidth)");
  async function login(email) {
    await until(text("Вход для сотрудников"));
    await fill("email", email);
    await fill("password", "local-test-password");
    await click("Продолжить");
    await until(text("Код приложения"));
    await fill("code", "123456");
    await click("Подтвердить");
    await until(text("Операционный обзор"));
  }
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: origin });
  await login("admin@example.invalid");
  await fit();
  assert.ok(await evaluate(text("Движения по валюте")));
  assert.ok(await evaluate(text("Данные устарели")));
  assert.ok(await evaluate(text("Источник недоступен")));
  await evaluate("document.body.tabIndex = -1; document.body.focus()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await until("document.activeElement.className === 'skip'");
  await click("Пользователи");
  await until(text(customer.email));
  await fit();
  assert.ok(await evaluate("document.querySelector('.table-scroll').tabIndex === 0"));
  await click("Тарифы");
  await until(text(plan.name));
  await click(plan.name);
  await until(text("История предложений"));
  await click("Опубликовать предложение");
  await fill("amountMinor", "10000");
  await fill("reason", "Проверка команды на стенде");
  await click("Проверить команду");
  await until(text("Свежий код TOTP"));
  await fill("password", "local-test-password");
  await fill("code", "123456");
  await click("Подтвердить и выполнить");
  await until(text("Повторить тот же запрос"));
  await click("Повторить тот же запрос");
  await until(text("persisted-command"));
  assert.equal(commandCalls, 2);
  assert.equal(commandBody.command.amountMinor, 10000);
  await click("Выйти");
  await login("support@example.invalid");
  assert.equal(await evaluate(text("Движения по валюте")), false);
  assert.equal(await evaluate("Boolean(document.querySelector('nav a[href=\"/staff\"]'))"), false);
  await click("Поддержка");
  await until(text(ticket.id));
  await click(ticket.id);
  await until(text(html));
  assert.equal(await evaluate("Boolean(window.adminUnsafe || document.querySelector('.messages img'))"), false);
  assert.equal(await evaluate(text("Ответить или изменить статус")), false);
  assert.ok(requests.every(value => value.startsWith(origin) || value.startsWith("data:")));
  console.log("Chromium 360 px: staff login, keyboard focus, dashboard freshness, ADMIN command retry, SUPPORT isolation and literal support text passed");
} finally {
  chromium?.ws.close();
  await chromium?.close();
  server.closeAllConnections();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
