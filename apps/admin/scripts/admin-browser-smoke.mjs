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
let role = "OWNER";
let capturingScreens = false;
let commandCalls = 0;
let commandKey;
let commandBody;
const fixtureSignInPassword = ["local", "test", "password"].join("-");
const fixtureTemporary = ["fixture", "disposable", "2026"].join("-");
const fixtureReplacement = ["fixture", "replacement", "2026"].join("-");
const visitedStaffOperations = [];
let stepUps = 0;
const customer = { activation: "PENDING", emailVerified: false, id: "id-customer", email: "p•••@example.invalid", status: "ACTIVE", createdAt: now };
const plan = { id: "fixture-plan", name: "MZT Standard", code: "standard", revision: 1, deviceLimit: 5, isActive: true };
const ticket = { id: "case-1", subject: "Уточнение по выдаче доступа", category: "DELIVERY", orderId: "order-1", status: "OPEN",
  priority: "HIGH", assignee: "team-operator", assigneeId: "staff-001", unread: 2, updatedAt: now };
const html = '<img src=x onerror="window.adminUnsafe=true">';
const order = { id: "order-1", userId: customer.id, status: "PAID", delivery: "VERIFY_PENDING", version: 2,
  createdAt: now, revision: 3, allocated: true, entitlement: "ACTIVE",
  snapshot: { durationMonths: 3, deviceLimit: 5, amount: 27000, currency: "RUB" },
  attempts: [{ status: "SUCCEEDED", providerTime: now }], allocation: { amountMinor: 27000, currency: "RUB" },
  period: { startAt: now, deviceLimit: 5 }, job: { id: "job-pending", status: "VERIFY_PENDING" },
  observations: [{ status: "STALE", receivedAt: now }] };
const job = { id: "job-pending", status: "VERIFY_PENDING", revision: 3, currentRevision: 3, attempts: 2, userId: customer.id, leaseUntil: null };
const movement = { id: "capture-001", kind: "CAPTURE", currency: "RUB", amountMinor: 27000, providerTime: now, allocation: order.id };
const unsettledMovement = { ...movement, id: "movement-002", currency: "USD", allocation: null };
const paymentCase = { id: "case-payment-001", kind: "UNKNOWN", status: "OPEN", priority: 2, nextCheckAt: now, updatedAt: now, version: 1 };
const staff = { username: "team-operator", id: "staff-001", email: "team@example.invalid", role: "ADMIN", version: 3, status: "ACTIVE", enrollmentState: "CONFIRMED" };
const session = { id: "session-fixture-001", userAgent: "Chromium Smoke", current: true, lastSeenAt: now, expiresAt: now, revokedAt: null };
const historical = { id: "audit-fixture-001", action: "plan.publish", actorId: staff.id, permission: "plans:write",
  entityId: plan.id, commandId: "local-audit-command", reason: "Локальная проверка", createdAt: now };
const listCustomer = Array.from({ length: 1010 }, (_, index) => index === 0 ? customer : {
  ...customer, id: "synthetic-operator-list-record-" + index, email: "synthetic-long-identifier-" + index + "•••@example.invalid",
});
const pages = items => ({ items, nextCursor: null });
const block = (data, state = "FRESH") => ({ data, state, observedAt: now });
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
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
    if (input.password !== fixtureSignInPassword) return json({ error: { code: "INVALID_CREDENTIALS" } }, 401);
    if (input.username === "initial-owner") { role = "OWNER"; return json({ step: "change_password", stageToken: "initial-only" }); }
    role = input.username.startsWith("support") ? "SUPPORT" : "OWNER";
    return json({ step: "verify_2fa", stageToken: "synthetic-only" });
  }
  if (path === "/api/auth/password/change-temporary") {
    assert.equal(input.stageToken, "initial-only");
    assert.equal(input.password, fixtureReplacement);
    signedIn = true;
    return json({ step: "authenticated" });
  }
  if (path === "/api/auth/2fa/verify") {
    if (input.code !== "123456") return json({ error: { code: "INVALID_CODE" } }, 401);
    signedIn = true;
    return json({});
  }
  if (!signedIn) return json({ error: { code: "UNAUTHENTICATED" } }, 401);
  if (path === "/api/auth/logout") { signedIn = false; return res.writeHead(204).end(); }
  const admin = role === "OWNER";
  const permissions = ["dashboard:read", "users:read", "orders:read", "plans:read", "support:read", "support:reply", "ops:read", "jobs:read",
    ...(admin ? ["plans:write", "finance:read", "audit:read", "staff:read", "staff:write", "users:create", "users:write", "security:self", "support:write"] : [])];
  if (path === "/api/me") return json({ user: { id: role, username: role.toLowerCase(), email: role.toLowerCase() + "@example.invalid", role },
    security: { policy: "required", enrolled: true, requiresTotp: true, version: 3 }, permissions });
  if (path === "/api/dashboard") return json({ asOf: now, users: block({ total: 1010, new: 18 }), subscriptions: block({ active: 82 }), orders: block({ paid: 56 }),
    jobs: block({ overdue: 3, errors: 1 }), payments: block({ stuck: 1, awaiting: 2 }), support: block({ open: 2 }), panel: block(null, "UNAVAILABLE"),
    worker: block(null, "STALE"), alerts: [{ kind: "jobs", reasonCode: "JOBS_OVERDUE" }], ...(admin ? { finance: block([{ currency: "RUB", captured: "100" }]) } : {}) });
  if (path === "/api/users/search" && req.method === "POST") {
    assert.equal(new URL(req.url, "http://127.0.0.1").search, "");
    return json({ ...pages(input.query === "synthetic@example.invalid" || input.userId === customer.id ? [customer] : []), truncated: false });
  }
  if (path === "/api/users") {
    if (!process.env.MZT_VISUAL_DIR) return json(pages([customer]));
    const start = Number(searchParams.get("cursor") ?? 0);
    const limit = Number(searchParams.get("limit") ?? 25);
    return json({ items: listCustomer.slice(start, start + limit), nextCursor: start + limit < listCustomer.length ? String(start + limit) : null });
  }
  if (path === "/api/orders") return json(pages([order]));
  if (path === "/api/orders/order-1") return json(order);
  if (path === "/api/orders/order-1/refunds") return json(pages([]));
  if (path === "/api/orders/order-1/finance") return json(pages([movement]));
  if (path === "/api/payments/cases") return json(pages([paymentCase]));
  if (path === "/api/payments/cases/case-payment-001") return json(paymentCase);
  if (path === "/api/payments/transactions") return json(pages([movement, unsettledMovement]));
  if (path === "/api/jobs") return json(pages([job]));
  if (path === "/api/jobs/job-pending") return json(job);
  if (path === "/api/staff") return json(pages([staff]));
  if (path === "/api/staff/staff-001") return json(staff);
  if (path === "/api/staff/staff-001/sessions" || path === "/api/auth/sessions") return json(pages([session]));
  if (path === "/api/audit") return json(pages([historical]));
  if (path === "/api/audit/audit-fixture-001") return json(historical);
  if (path === "/api/subscriptions") return json(pages([{ id: "subscription-fixture-001", userId: customer.id, revision: 3,
    panelBinding: null, _count: { periods: 1 }, nextBoundaryAt: now }]));
  if (path === "/api/config") return json({ version: 1, product: { brandName: "Компания «Магазин связи»" } });
  if (path === "/api/operations/status") return json({ asOf: now,
    product: { registration: true, payments: false, maintenance: false, remnawave: "DISABLED", platega: "CONTRACT_BLOCKED" }, services: [
    { key: "worker", state: "STALE", observedAt: now, data: null, reasonCode: "WORKER_STALE" },
    { key: "panel", state: "UNAVAILABLE", observedAt: null, data: null, reasonCode: "PANEL_UNAVAILABLE" },
  ], alerts: [{ id: "panel", kind: "panel", reasonCode: "PANEL_UNAVAILABLE" }] });
  if (path === "/api/users/id-customer") return json({ ...customer, right: "ACTIVE", subscription: null, version: now,
    identities: [{ provider: "EMAIL" }, { provider: "TELEGRAM" }],
    ...(admin && { access: { hasPassword: true, mailAvailable: false, emailResetEligible: false } }) });
  if (path === "/api/users/id-customer/periods") return json(pages([{ id: "period-fixture-001", orderId: order.id, serial: 1,
    startAt: now, endAt: now, deviceLimit: 5 }]));
  if (path === "/api/plans") return json(pages([plan]));
  if (path === "/api/plans/fixture-plan/versions") return json({ plan, ...pages(process.env.MZT_VISUAL_DIR ? [
    { id: "offer-001", version: 1, name: plan.name, amount: 9000, currency: "RUB", deviceLimit: 3, durationMonths: 1, withdrawnAt: now },
    { id: "offer-002", version: 2, name: plan.name, amount: 11000, currency: "RUB", deviceLimit: 5, durationMonths: 1, publishedAt: now },
  ] : []) });
  if (path === "/api/support/assignees") return json({ items: [{ id: staff.id, username: staff.username }] });
  if (path === "/api/support/cases") return json(pages([ticket]));
  if (path === "/api/support/cases/case-1") return json({ case: ticket, messages: pages([{ id: "msg", author: "CUSTOMER", text: capturingScreens ? "Платёж подтверждён. Когда появится доступ?" : html, createdAt: now }]),
    history: pages([]) });
  if (path === "/api/auth/sessions/revoke-others" && req.method === "POST") {
    visitedStaffOperations.push("revoke-others");
    return res.writeHead(204).end();
  }
  if (path === "/api/auth/step-up") {
    stepUps++;
    if (input.code !== "123456" || !permissions.includes(input.permission) || !admin) return json({ error: { code: "FORBIDDEN" } }, 403);
    return json({ confirmationId: "confirmation-test" });
  }
  if (path.startsWith("/api/commands/")) {
    const operation = path.split("/")[3];
    if (["staff.create", "user.create", "user.activate", "staff.role", "support.reply", "user.password.set"].includes(operation)) {
      if (["staff.role", "staff.create", "user.password.set"].includes(operation)) assert.equal(input.confirmationId, "confirmation-test");
      else assert.equal(input.confirmationId, undefined);
      if (operation !== "staff.role") assert.equal(input.reason, undefined);
      if (operation === "user.create") assert.deepEqual(Object.keys(input.command), ["email"]);
      visitedStaffOperations.push(operation);
      return json({ commandId: operation + "-saved", result: { id: "fixture-committed" } });
    }
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
  async function click(value) {
    const target = `[...document.querySelectorAll("a,button,summary")].find(node =>
      node.textContent.trim() === ${JSON.stringify(value)} && node.checkVisibility() && !node.disabled &&
      (!document.querySelector("dialog[open]") || node.closest("dialog[open]") === [...document.querySelectorAll("dialog[open]")].at(-1)))`;
    await until(`(() => { const control = ${target}; if (!control) return false; control.click(); return true; })()`);
  }
  const submitRoutine = value => until(`(() => {
    const section = [...document.querySelectorAll("details[open]")].find(node =>
      node.querySelector("summary").textContent.trim() === ${JSON.stringify(value)});
    const button = section?.querySelector('button[type="submit"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  const fill = (name, value) => evaluate(`[...document.querySelectorAll('[name=' + ${JSON.stringify(name)} + ']')].find(node => node.checkVisibility() && (!document.querySelector('dialog[open]') || node.closest('dialog[open]') === [...document.querySelectorAll('dialog[open]')].at(-1))).value = ${JSON.stringify(value)}`);
  const menu = async value => {
    await evaluate('document.querySelector(`button[aria-label="Открыть меню"]`).click()');
    await until('Boolean(document.querySelector("dialog[open]"))');
    await click(value);
  };
  const fit = () => until("Boolean(document.documentElement && document.documentElement.scrollWidth <= innerWidth)");
  async function login(username) {
    await until(text("Вход"));
    await fill("username", username.split("@")[0]);
    await fill("password", fixtureSignInPassword);
    await click("Продолжить");
    await until(text("Код приложения"));
    await fill("code", "000000");
    await click("Подтвердить");
    await until(text("Код неверен или уже использован"));
    assert.equal(await evaluate(text("Админ-панель MZT")), false);
    await fill("code", "123456");
    await click("Подтвердить");
    await until(text("Админ-панель MZT"));
  }
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: origin });
  await login("admin@example.invalid");
  await fit();
  await until(text("Движения по валюте"));
  await until(text("Данные устарели"));
  await until(text("Источник недоступен"));
  await evaluate("document.body.tabIndex = -1; document.body.focus()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await until("document.activeElement.className === 'skip'");
  await evaluate(`document.querySelector(".mz-mobile-nav a[href='/operations']").click()`);
  await until(text("Состояние фоновых процессов"));
  await evaluate(`document.querySelector(".mz-mobile-nav a[href='/users']").click()`);
  await until(text(customer.email));
  await fit();
  assert.ok(await evaluate("document.querySelector('.mz-table-scroll').tabIndex === 0"));
  await evaluate('document.querySelector(".admin-users-filter summary").click()');
  await fill("status", "ACTIVE");
  await click("Применить фильтры");
  await until("new URLSearchParams(location.search).get('status') === 'ACTIVE'");
  assert.equal(await evaluate("Boolean(document.querySelector('.mz-drawer[open]'))"), false);
  await evaluate('document.querySelector(".admin-search-trigger").click()');
  await until(text("Поиск клиентов"));
  await evaluate(`(() => {
    const field = document.querySelector("#admin-search-query");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "synthetic@example.invalid");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await click("Найти");
  await click(customer.email);
  await until('Boolean(document.querySelector(".mz-drawer[open]"))');
  assert.ok(await evaluate("Boolean(document.querySelector('.admin-compact-users')) && !location.href.includes('synthetic@example.invalid')"));
  await click("К списку");
  await until("location.pathname === '/users' && !document.querySelector('.mz-drawer[open]')");
  await click(customer.email);
  await until('Boolean(document.querySelector(".mz-drawer[open]"))');
  await click("К списку");
  await until("document.activeElement.id === 'row-id-customer'");
  await menu("Тарифы");
  await until(text(plan.name));
  await click(plan.name);
  await until(text("История предложений"));
  await click("Опубликовать предложение");
  await fill("amountMinor", "10000");
  await fill("reason", "Проверка команды на стенде");
  await evaluate('[...document.querySelectorAll("button")].find(button => button.checkVisibility() && button.textContent === "Проверить команду").focus()');
  await click("Проверить команду");
  await until(text("Свежий код TOTP"));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("!document.querySelector('dialog[open]') && document.activeElement.textContent === 'Проверить команду'");
  await click("Проверить команду");
  await until(text("Свежий код TOTP"));
  await fill("password", fixtureSignInPassword);
  await fill("code", "123456");
  await click("Подтвердить и выполнить");
  await until(text("Повторить тот же запрос"));
  await click("Повторить тот же запрос");
  await until(text("persisted-command"));
  assert.equal(commandCalls, 2);
  assert.equal(commandBody.command.amountMinor, 10000);
  async function confirmIdentity(withReason = true) {
    if (withReason) await fill("reason", "Проверка команды на стенде");
    await click("Проверить команду");
    await until(text("Свежий код TOTP"));
    assert.equal(await evaluate(text(fixtureTemporary)), false);
    await fill("password", fixtureSignInPassword);
    await fill("code", "123456");
    await click("Подтвердить и выполнить");
  }
  await menu("Сотрудники");
  await click("Создать сотрудника");
  await fill("username", "new-employee");
  await fill("temporaryPassword", fixtureTemporary);
  await confirmIdentity(false);
  await until(text("staff.create-saved"));
  await click(staff.username);
  await click("Изменить роль и завершить сессии");
  await fill("role", "SUPPORT");
  await confirmIdentity();
  await until(text("staff.role-saved"));
  await fit();
  await menu("Пользователи");
  const beforeRoutine = stepUps;
  await click("Создать заявку клиента");
  await fill("email", "fixture-created@example.invalid");
  await submitRoutine("Создать заявку клиента");
  await until(text("user.create-saved"));
  await click(customer.email);
  await until(text("Email и пароль, Telegram"));
  assert.ok(await evaluate(text("почтовая отправка отключена")));
  await click("Активировать аккаунт вручную");
  await submitRoutine("Активировать аккаунт вручную");
  await until(text("user.activate-saved"));
  assert.equal(stepUps, beforeRoutine);
  await click("Установить новый пароль");
  await fill("password", fixtureReplacement);
  await confirmIdentity(false);
  await until(text("user.password.set-saved"));
  await click("К списку");
  await menu("Сессии");
  await click("Завершить остальные сессии");
  await until(text("Политика: Обязательна"));
  assert.deepEqual(visitedStaffOperations, ["staff.create", "staff.role", "user.create", "user.activate", "user.password.set", "revoke-others"]);
  await fit();
  await click("Выйти");
  await login("support@example.invalid");
  await until(text("Открытые обращения"));
  assert.equal(await evaluate(text("Движения по валюте")), false);
  assert.equal(await evaluate("Boolean(document.querySelector('nav a[href=\"/staff\"]'))"), false);
  await menu("Пользователи");
  await until(text(customer.email));
  assert.equal(await evaluate(text("Создать заявку клиента")), false);
  await send("Page.navigate", { url: origin + "/payments" });
  await until(text("Раздел закрыт"));
  await menu("Поддержка");
  await until(text(ticket.id));
  await click(ticket.id);
  await until(text(html));
  assert.equal(await evaluate("Boolean(window.adminUnsafe || document.querySelector('.messages img'))"), false);
  assert.equal(await evaluate(text("Ответить или изменить статус")), false);
  assert.ok(await evaluate(text("Ответить")));
  assert.equal(await evaluate(text("Назначить ответственного")), false);
  const beforeReply = stepUps;
  await click("Ответить");
  await fill("publicReply", "Проверка ответа через рабочую форму");
  await submitRoutine("Ответить");
  await until(text("support.reply-saved"));
  assert.equal(stepUps, beforeReply);
  await fit();
  assert.ok(requests.every(value => value.startsWith(origin) || value.startsWith("data:")));
  await click("Выйти");
  await until(text("Вход"));
  await fill("username", "initial-owner");
  await fill("password", fixtureSignInPassword);
  await click("Продолжить");
  await until(text("Задайте новый пароль"));
  assert.equal(await evaluate(text("Админ-панель MZT")), false);
  await fill("password", fixtureReplacement);
  await fill("confirm", fixtureReplacement);
  await click("Сменить пароль");
  await until(text("Админ-панель MZT"));
  console.log("Chromium 360 px: rejected TOTP, mobile filters, dialog Escape/focus, freshness, command retry, OWNER operations, initial password stage and SUPPORT isolation passed");
  if (process.env.MZT_VISUAL_DIR) {
    capturingScreens = true;
    await visualQa({ site: "admin", dist, send, evaluate, until, origin,
      prepare: screen => { signedIn = !screen.guest; role = "OWNER"; },
      afterLoad: async () => {
        await click("Опубликовать предложение");
        await fill("amountMinor", "10000");
        await fill("reason", "Локальная визуальная проверка");
        await click("Проверить команду");
        await until(text("Свежий код TOTP"));
      },
      screens: [
        { id: "login", path: "/login", ready: "Вход", guest: true, measure: true },
        { id: "invitation", path: "/invitation", ready: "Код приглашения", guest: true },
        { id: "dashboard", path: "/", ready: "Движения по валюте", measure: true },
        { id: "users", path: "/users", ready: customer.email },
        { id: "user-details", path: "/users/id-customer", ready: customer.email },
        { id: "user-periods", path: "/users/id-customer/periods", ready: order.id },
        { id: "subscriptions", path: "/subscriptions", ready: customer.id },
        { id: "orders", path: "/orders", ready: order.id },
        { id: "order-details", path: "/orders/order-1", ready: "От оплаты до подключения" },
        { id: "order-finance", path: "/orders/order-1/finance", ready: movement.id },
        { id: "payments", path: "/payments", ready: movement.id },
        { id: "payment-cases", path: "/payments/cases", ready: paymentCase.id },
        { id: "payment-case-details", path: "/payments/cases/case-payment-001", ready: paymentCase.id },
        { id: "fulfillment", path: "/jobs", ready: job.id },
        { id: "fulfillment-details", path: "/jobs/job-pending", ready: job.id },
        { id: "plans", path: "/plans", ready: plan.name },
        { id: "offer-versions", path: "/plans/fixture-plan", ready: "offer-002" },
        { id: "offer-confirmation", path: "/plans/fixture-plan", ready: "offer-002", afterLoad: true },
        { id: "support", path: "/support", ready: ticket.id },
        { id: "support-thread", path: "/support/case-1", ready: "Переписка" },
        { id: "staff", path: "/staff", ready: staff.username },
        { id: "staff-details", path: "/staff/staff-001", ready: staff.email },
        { id: "staff-sessions", path: "/staff/staff-001/sessions", ready: session.id },
        { id: "security", path: "/security", ready: session.id },
        { id: "audit", path: "/audit", ready: historical.action },
        { id: "audit-details", path: "/audit/audit-fixture-001", ready: historical.action },
        { id: "operations", path: "/operations", ready: "Источник недоступен" },
        { id: "not-found", path: "/page-not-found", ready: "Страница не найдена" },
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
