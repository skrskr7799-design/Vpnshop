// Run with node >=22 and a local Chromium after building @vpn/web.
// All backend responses are synthetic; the browser uses the real bundled client.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

const price = { amountMinor: 10000, currency: "RUB" };
const offer = { id: "offer-smoke", name: "MZT Smoke", durationMonths: 1, deviceLimit: 3, price };
const snapshot = { ...offer, snapshottedAt: now, expiresAt: later };
const order = { id: "order-smoke", orderState: "OPEN", moneyStatus: "WAITING", deliveryStatus: "NOT_REQUESTED",
  createdAt: now, expiresAt: later, snapshot, allowedChannels: [], canStartPayment: false, refunds: [] };
const period = { id: "period-smoke", startAt: now, endAt: later, effectiveEndAt: later, snapshot, adjustments: [] };
const page = items => ({ items, nextCursor: null });
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
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
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const json = (body, status = 200) => res.writeHead(status).end(JSON.stringify(body));
  if (path === "/api/auth/me") return signedIn ? json({ user, sessionId }) : json({ error: { code: "UNAUTHENTICATED" } }, 401);
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
  if (path === "/api/plans") return json({ offers: [offer], asOf: now });
  if (path === "/api/orders" && req.method === "POST") {
    checkoutKeys.push(req.headers["idempotency-key"]);
    if (checkoutKeys.length === 1) return json({ error: { code: "INTERNAL" } }, 503);
    return json({ orderId: order.id }, 201);
  }
  if (path === "/api/orders") return json(page(checkoutKeys.length > 1 ? [order] : []));
  if (path === "/api/orders/order-smoke") return json(order);
  if (path === "/api/orders/order-smoke/payments") return json(page([]));
  if (path === "/api/me/subscription") return json({ serverTime: now, subscription: {
    rightStatus: "ACTIVE", currentPeriod: period, coverageEndsAt: later, paidThroughAt: later,
    delivery: { status: "READY", observedAt: now },
  } });
  if (path === "/api/me/subscription/access") return json({ subscriptionUrl: url });
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

let browser;
let ws;
try {
  await readFile(join(dist, "index.html"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  browser = spawn(process.env.CHROMIUM_BIN ?? "chromium", ["--headless", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu", "--no-first-run", "--disable-background-networking", "--remote-debugging-port=0",
    "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
  let debugPort;
  for (let i = 0; i < 100 && !debugPort; i++) {
    debugPort = await readFile(join(profile, "DevToolsActivePort"), "utf8").then(value => value.split("\n")[0], () => "");
    if (!debugPort) await delay(50);
  }
  assert.ok(debugPort, "Chromium DevTools unavailable");
  const targets = await fetch("http://127.0.0.1:" + debugPort + "/json/list").then(r => r.json());
  ws = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await once(ws, "open");
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
  const click = value => evaluate(`[...document.querySelectorAll("a,button")].find(e => e.textContent.trim() === ${JSON.stringify(value)}).click()`);
  const fit = () => until("Boolean(document.documentElement && document.documentElement.scrollWidth <= innerWidth)");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: origin + "/account" });
  await until(text("Доступ подтверждён"));
  await fit();
  await click("Тарифы");
  await until(text("Создать заказ"));
  await fit();
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
  await click("Безопасность");
  await until(text("Chromium Smoke"));
  await click("Подключение");
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
  console.log("Chromium 360 px: account, checkout retry, order support with literal HTML, security, local QR and failed/retried logout passed");
} finally {
  ws?.close();
  if (browser?.pid) { browser.kill("SIGTERM"); await once(browser, "exit"); }
  server.closeAllConnections();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
