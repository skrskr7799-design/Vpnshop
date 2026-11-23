// Run with node >=22 and a local Chromium after building @vpn/web.
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
const profile = await mkdtemp(join(tmpdir(), "mzt-browser-smoke-"));
const now = new Date().toISOString();
const later = new Date(Date.now() + 86_400_000).toISOString();
const url = "https://links.example.invalid/s/synthetic-secret";
const payload = "<img src=x onerror=window.__supportUnsafe=true>";
const user = { id: "synthetic-user", email: "test@example.invalid", role: "USER" };
const sessionId = "synthetic-browser-session";
let signedIn = true;
let checkoutKeys = [];
let history = [];
let ticket;
let failLogout = true;
let subscriptionState = "ACTIVE";
let accessRequests = 0;
let slowOverview = false;

const price = { amountMinor: 10000, currency: "RUB" };
const offer = { id: "offer-smoke", name: "MZT Smoke", durationMonths: 1, deviceLimit: 3, price };
const visualOffers = [offer, { ...offer, name: "MZT · 3 месяца", id: "offer-3", durationMonths: 3, deviceLimit: 5,
  price: { amountMinor: 27000, currency: "RUB" } }, { ...offer, name: "MZT · 6 месяцев", id: "offer-6", durationMonths: 6, deviceLimit: 7,
  price: { amountMinor: 49000, currency: "RUB" } }];
const snapshot = { ...offer, snapshottedAt: now, expiresAt: later };
const order = { id: "order-smoke", orderState: "OPEN", moneyStatus: "WAITING", deliveryStatus: "NOT_REQUESTED",
  createdAt: now, expiresAt: later, snapshot, allowedChannels: [], canStartPayment: false, refunds: [] };
const period = { id: "period-smoke", deviceLimit: 3, startAt: now, endAt: later, effectiveEndAt: later, snapshot, adjustments: [] };
const page = items => ({ items, nextCursor: null });
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (!path.startsWith("/api/")) {
    const filename = path.startsWith("/assets/") ? join(dist, path) : join(dist, "index.html");
    try {
      serveAsset(req, res, mime[extname(filename)] ?? "application/octet-stream", filename, await readFile(filename));
    } catch { res.writeHead(404).end(); }
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const json = (body, status = 200) => res.writeHead(status).end(JSON.stringify(body));
  if (path === "/api/auth/me") return signedIn ? json({ user, sessionId }) : json({ error: { code: "UNAUTHENTICATED" } }, 401);
  if (path === "/api/auth/login") {
    req.resume();
    return json({ error: { code: "INVALID_CREDENTIALS" } }, 401);
  }
  if (path === "/api/auth/refresh") return json({ error: { code: "INVALID_SESSION" } }, 401);
  if (path === "/api/auth/oauth/providers") return json({ providers: { google: false, telegram: false } });
  if (path === "/api/auth/logout") {
    if (failLogout) { failLogout = false; return json({ error: { code: "INTERNAL" } }, 503); }
    signedIn = false;
    return res.writeHead(204).end();
  }
  if (!signedIn || req.headers["x-mzt-session"] !== sessionId) return json({ error: { code: "UNAUTHENTICATED" } }, 401);
  if (path === "/api/auth/oauth/identities") return json({ providers: ["EMAIL"], identities: [{ provider: "EMAIL", verified: true, usable: true, canUnlink: false }] });
  if (path === "/api/auth/oauth/reauth") return json({ confirmations: [] });
  if (path === "/api/auth/sessions") return json({ sessions: [{ id: sessionId, device: "Chromium Smoke", current: true, lastSeenAt: now }] });
  if (path === "/api/plans") return json({ offers: process.env.MZT_VISUAL_DIR ? visualOffers : [offer], asOf: now });
  if (path === "/api/orders" && req.method === "POST") {
    checkoutKeys.push(req.headers["idempotency-key"]);
    if (checkoutKeys.length === 1) return json({ error: { code: "INTERNAL" } }, 503);
    return json({ orderId: order.id }, 201);
  }
  if (path === "/api/orders") return json(page(subscriptionState !== "EMPTY" && checkoutKeys.length > 1 ? [order] : []));
  if (path === "/api/orders/order-smoke") return json(order);
  if (path === "/api/orders/order-smoke/payments") return json(page([]));
  if (path === "/api/me/subscription") {
    if (slowOverview) await delay(850);
    if (subscriptionState === "ERROR") return json({ error: { code: "INTERNAL" } }, 503);
    const active = subscriptionState === "ACTIVE";
    return json({ serverTime: now, subscription: subscriptionState === "EMPTY" ? null : {
      rightStatus: subscriptionState, currentPeriod: active ? period : null, coverageEndsAt: active ? later : null, paidThroughAt: later,
      delivery: { status: active ? "READY" : "EXPIRED", observedAt: now, observationFresh: active },
    } });
  }
  if (path === "/api/me/subscription/periods") return json(page([period]));
  if (path === "/api/me/subscription/access") { accessRequests++; return json({ subscriptionUrl: url }); }
  if (path === "/api/me/support/cases" && req.method === "GET") return json(page(ticket ? [ticket] : []));
  if (path.startsWith("/api/me/support/cases") && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { message, orderId } = JSON.parse(Buffer.concat(chunks));
    ticket ??= { id: "case-smoke", orderId, category: "PAYMENT", status: "OPEN", createdAt: now, updatedAt: now };
    const entry = { id: String(history.length), author: "CUSTOMER", text: message, createdAt: now };
    history = [entry, ...history];
    return json({ case: ticket, message: entry }, 201);
  }
  if (path === "/api/me/support/cases/case-smoke") return json({ case: ticket, messages: page(history), history: page([]) });
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
  const click = value => evaluate(`[...document.querySelectorAll("a,button")].find(e => e.getClientRects().length && (!document.querySelector("dialog[open]") || e.closest("dialog[open]")) && e.textContent.trim() === ${JSON.stringify(value)}).click()`);
  const menu = async value => {
    await evaluate('document.querySelector(`button[aria-label="Открыть меню"]`).click()');
    await until('Boolean(document.querySelector("dialog[open]"))');
    await click(value);
  };
  const fit = () => until("Boolean(document.documentElement && document.documentElement.scrollWidth <= innerWidth)");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: origin + "/account" });
  await until(text("Доступ подтверждён"));
  await fit();
  assert.equal(accessRequests, 0);
  assert.equal(await evaluate(text(url)), false);
  await evaluate(`document.querySelector(".mz-mobile-nav a[href='/account/subscription']").click()`);
  await until(text("Состояние подписки"));
  await evaluate(`document.querySelector(".mz-mobile-nav a[href='/account']").click()`);
  await until(text("Мой кабинет"));
  await evaluate('[...document.querySelectorAll(".mz-mobile-nav button")].find(x => x.textContent.trim() === "Ещё").click()');
  await until('Boolean(document.querySelector("dialog[open]"))');
  await click("Тарифы");
  await until(text("Выбрать"));
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Выбрать").focus()');
  await click("Выбрать");
  await until(text("Создать заказ"));
  await fit();
  await send("Accessibility.enable");
  const { nodes } = await send("Accessibility.getFullAXTree");
  assert.ok(nodes.some(node => node.role?.value === "dialog" && node.name?.value === "Проверьте условия"));
  for (const key of ["Tab", "Tab", "Tab", "Tab"]) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: 9 });
    assert.ok(await evaluate("document.activeElement === document.body || Boolean(document.activeElement.closest('dialog[open]'))"));
  }
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until("document.activeElement.textContent.trim() === 'Выбрать' && !document.querySelector('dialog[open]')");
  await click("Выбрать");
  await until(text("Создать заказ"));
  await click("Создать заказ");
  await until(text("Действие не завершилось"));
  await click("Создать заказ");
  await until(text("Оплата сейчас недоступна"));
  assert.ok(checkoutKeys[0] && checkoutKeys[0] === checkoutKeys[1]);
  await click("Помощь с заказом");
  await until(text("Новое обращение"));
  await fit();
  await evaluate(`document.querySelector("textarea").value = ${JSON.stringify(payload)}`);
  await click("Создать обращение");
  await until(text(payload));
  assert.equal(ticket.orderId, order.id);
  assert.equal(await evaluate("Boolean(window.__supportUnsafe || document.querySelector('.mzt-message img'))"), false);
  await evaluate(`
    const input = document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Можно уточнить?");
    input.dispatchEvent(new Event("input", {bubbles:true}));
  `);
  await click("Отправить");
  await until(text("Можно уточнить?"));
  await menu("Безопасность");
  await until(text("Chromium Smoke"));
  await menu("Подключение");
  await until(text("Показать ссылку и QR"));
  await click("Показать ссылку и QR");
  await until('Boolean(document.querySelector("svg.mzt-qr path"))');
  await fit();
  assert.ok(await evaluate(`[sessionStorage, localStorage].every(storage => !JSON.stringify(storage).includes(${JSON.stringify(url)}))`));
  assert.ok(requests.every(value => value.startsWith(origin) || value.startsWith("data:")));
  await click("Выйти");
  await until(text("Серверный выход ещё не подтверждён"));
  assert.ok(await evaluate("!document.querySelector('.mzt-account, .mzt-qr')"));
  await click("Повторить выход");
  await until("document.body && !document.body.innerText.includes('Серверный выход ещё не подтверждён')");
  assert.equal(signedIn, false);

  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 440, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: origin + "/login" });
  await until(text("Добро пожаловать"));
  await evaluate(`for (const [name,value] of [["email","synthetic@example.invalid"],["password","not-a-real-password"]]) {
    const input = document.querySelector("[name=" + name + "]");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles:true}));
    input.focus();
  }`);
  assert.ok(await evaluate(`(() => {
    const button = document.querySelector(".auth-form button[type='submit']");
    button.scrollIntoView({block:"center"});
    const rect = button.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })()`));
  await click("Войти");
  await until(text("Неверный email или пароль"));
  await fit();
  signedIn = true;
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  slowOverview = true;
  await send("Page.navigate", { url: origin + "/account" });
  await until('Boolean(document.querySelector("main .mz-skeleton"))');
  await until(text("Активная подписка"));
  slowOverview = false;
  for (const [state, expected] of [["EMPTY", "Нет подписки"], ["EXPIRED", "Подписка истекла"], ["ERROR", "Действие не завершилось"]]) {
    subscriptionState = state;
    await send("Page.navigate", { url: origin + "/account" });
    await until(text(expected));
    assert.equal(await evaluate(text("Показать ссылку и QR")), false);
    await fit();
  }
  subscriptionState = "ACTIVE";
  assert.equal(accessRequests, 1);
  console.log("Chromium 360 px: mobile routes, loading/empty/active/expired/error, denied login at reduced viewport height, local QR and logout passed");
  if (process.env.MZT_VISUAL_DIR) {
    await visualQa({ site: "web", dist, send, evaluate, until, origin,
      prepare: screen => { signedIn = !screen.guest; },
      afterLoad: async () => { await click("Выбрать"); await until(text("Проверьте условия")); },
      screens: [
        { id: "login", path: "/login", ready: "Войти", guest: true, measure: true },
        { id: "register", path: "/register", ready: "Пароль", guest: true },
        { id: "dashboard", path: "/account", ready: "Показать ссылку и QR", measure: true },
        { id: "plans", path: "/account/plans", ready: offer.name },
        { id: "checkout", path: "/account/plans", ready: offer.name, afterLoad: true },
        { id: "order", path: "/account/orders/order-smoke", ready: "Попытки оплаты" },
        { id: "orders", path: "/account/orders", ready: offer.name },
        { id: "subscription", path: "/account/subscription", ready: "Состояние подписки" },
        { id: "connection", path: "/account/connect", ready: "Показать ссылку и QR" },
        { id: "support", path: "/account/support", ready: "Мои обращения" },
        { id: "support-thread", path: "/account/support/case-smoke", ready: "Можно уточнить?" },
        { id: "security", path: "/account/security", ready: "Chromium Smoke" },
      ] });
  }
} finally {
  chromium?.ws.close();
  await chromium?.close();
  server.closeAllConnections();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
