// Run with node >=22 and a local Chromium after building @vpn/admin.
// All backend responses are synthetic; the browser uses the real bundled client.
import assert from "node:assert/strict";
import { launchChromium } from "../../../scripts/smoke-chromium.mjs";
import { serveAsset, visualQa } from "../../../scripts/visual-qa.mjs";
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
const order = { id: "order-1", userId: customer.id, status: "PAID", delivery: "VERIFY_PENDING", version: 2,
  createdAt: now, revision: 3, allocated: true, entitlement: "ACTIVE",
  snapshot: { durationMonths: 3, deviceLimit: 5, amount: 27000, currency: "RUB" },
  attempts: [{ status: "SUCCEEDED", providerTime: now }], allocation: { amountMinor: 27000, currency: "RUB" },
  period: { startAt: now, deviceLimit: 5 }, job: { id: "job-pending", status: "VERIFY_PENDING" },
  observations: [{ status: "STALE", receivedAt: now }] };
const job = { id: "job-pending", status: "VERIFY_PENDING", revision: 3, currentRevision: 3, attempts: 2, userId: customer.id, leaseUntil: null };
const movement = { id: "capture-001", kind: "CAPTURE", currency: "RUB", amountMinor: 27000, providerTime: now, allocation: order.id };
const staff = { id: "staff-001", email: "team@example.invalid", role: "ADMIN", version: 3, status: "ACTIVE", enrollmentState: "CONFIRMED" };
const listCustomer = Array.from({ length: 1010 }, (_, index) => index === 0 ? customer : {
  ...customer, id: "synthetic-operator-list-record-" + index, email: "synthetic-long-identifier-" + index + "•••@example.invalid",
});
const pages = items => ({ items, nextCursor: null });
const block = (data, state = "FRESH") => ({ data, state, observedAt: now });
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  const { pathname: path, searchParams } = new URL(req.url, "http://127.0.0.1");
  if (!path.startsWith("/api/")) {
    const filename = path.startsWith("/assets/") ? join(dist, path) : join(dist, "index.html");
    try {
      serveAsset(req, res, mime[extname(filename)] ?? "application/octet-stream", filename, await readFile(filename));
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
  if (path === "/api/dashboard") return json({ asOf: now, users: block({ total: 1010, new: 18 }), subscriptions: block({ active: 82 }), orders: block({ paid: 56 }),
    jobs: block({ active: 3, errors: 1 }), support: block({ open: 2 }), panel: block(null, "UNAVAILABLE"),
    worker: block(null, "STALE"), alerts: [], ...(admin ? { finance: block([{ currency: "RUB", captured: "100" }]) } : {}) });
  if (path === "/api/users") {
    if (!process.env.MZT_VISUAL_DIR) return json(pages([customer]));
    const start = Number(searchParams.get("cursor") ?? 0);
    return json({ items: listCustomer.slice(start, start + 25), nextCursor: start + 25 < listCustomer.length ? String(start + 25) : null });
  }
  if (path === "/api/orders") return json(pages([order]));
  if (path === "/api/orders/order-1") return json(order);
  if (path === "/api/orders/order-1/refunds" || path === "/api/payments/cases") return json(pages([]));
  if (path === "/api/payments/transactions") return json(pages([movement]));
  if (path === "/api/jobs") return json(pages([job]));
  if (path === "/api/jobs/job-pending") return json(job);
  if (path === "/api/staff") return json(pages([staff]));
  if (path === "/api/operations/status") return json({ asOf: now, services: [
    { key: "worker", state: "FRESH", observedAt: now, data: { ready: true }, reasonCode: null },
    { key: "panel", state: "UNAVAILABLE", observedAt: null, data: null, reasonCode: "PANEL_UNAVAILABLE" },
  ], alerts: [{ id: "panel", kind: "panel", reasonCode: "PANEL_UNAVAILABLE" }] });
  if (path === "/api/users/id-customer") return json({ ...customer, right: "ACTIVE", subscription: null, version: now });
  if (path === "/api/plans") return json(pages([plan]));
  if (path === "/api/plans/fixture-plan/versions") return json({ plan, ...pages(process.env.MZT_VISUAL_DIR ? [
    { id: "offer-001", version: 1, name: plan.name, amount: 9000, currency: "RUB", deviceLimit: 3, durationMonths: 1, withdrawnAt: now },
    { id: "offer-002", version: 2, name: plan.name, amount: 11000, currency: "RUB", deviceLimit: 5, durationMonths: 1, publishedAt: now },
  ] : []) });
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
  const click = value => evaluate(`[...document.querySelectorAll("a,button,summary")].find(node => node.textContent.trim() === ${JSON.stringify(value)} && node.checkVisibility() && (!document.querySelector("dialog[open]") || node.closest("dialog[open]"))).click()`);
  const fill = (name, value) => evaluate(`[...document.querySelectorAll('[name=' + ${JSON.stringify(name)} + ']')].find(node => node.checkVisibility()).value = ${JSON.stringify(value)}`);
  const menu = async value => {
    await evaluate('document.querySelector(`button[aria-label="Открыть меню"]`).click()');
    await until('Boolean(document.querySelector("dialog[open]"))');
    await click(value);
  };
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
  await menu("Пользователи");
  await until(text(customer.email));
  await fit();
  assert.ok(await evaluate("document.querySelector('.mz-table-scroll').tabIndex === 0"));
  await menu("Тарифы");
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
  await menu("Поддержка");
  await until(text(ticket.id));
  await click(ticket.id);
  await until(text(html));
  assert.equal(await evaluate("Boolean(window.adminUnsafe || document.querySelector('.messages img'))"), false);
  assert.equal(await evaluate(text("Ответить или изменить статус")), false);
  assert.ok(requests.every(value => value.startsWith(origin) || value.startsWith("data:")));
  console.log("Chromium 360 px: staff login, keyboard focus, dashboard freshness, ADMIN command retry, SUPPORT isolation and literal support text passed");
  if (process.env.MZT_VISUAL_DIR) {
    await visualQa({ site: "admin", dist, send, evaluate, until, origin,
      prepare: screen => { signedIn = !screen.guest; role = "ADMIN"; }, afterLoad: () => {},
      screens: [
        { id: "login", path: "/login", ready: "Вход для сотрудников", guest: true, measure: true },
        { id: "dashboard", path: "/", ready: "Движения по валюте", measure: true },
        { id: "users", path: "/users", ready: customer.email },
        { id: "user-details", path: "/users/id-customer", ready: customer.email },
        { id: "orders", path: "/orders", ready: order.id },
        { id: "order-details", path: "/orders/order-1", ready: "От оплаты до подключения" },
        { id: "payments", path: "/payments", ready: movement.id },
        { id: "fulfillment", path: "/jobs", ready: job.id },
        { id: "plans", path: "/plans", ready: plan.name },
        { id: "offer-versions", path: "/plans/fixture-plan", ready: "offer-002" },
        { id: "support", path: "/support", ready: ticket.id },
        { id: "support-thread", path: "/support/case-1", ready: "Переписка" },
        { id: "staff", path: "/staff", ready: staff.email },
        { id: "operations", path: "/operations", ready: "Источник недоступен" },
      ] });
    await send("Page.navigate", { url: origin + "/users?status=ACTIVE&cursor=1000" });
    await until(text("10 на странице"));
    assert.equal(await evaluate("document.querySelectorAll('.mz-table-scroll tbody tr').length"), 10);
    await click("К началу");
    await until(text("25 на странице"));
    assert.ok(await evaluate("location.search.includes('status=ACTIVE') && !location.search.includes('cursor=')"));
    await click(customer.email);
    await until(text("К списку"));
    await click("К списку");
    await until("document.activeElement.id === 'row-id-customer'");
    assert.ok(await evaluate("location.search.includes('status=ACTIVE')"));
  }
} finally {
  chromium?.ws.close();
  await chromium?.close();
  server.closeAllConnections();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
