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
const emailToken = "synthetic-email-token";
const user = { id: "synthetic-user", email: "test@example.invalid", role: "USER" };
const sessionId = "synthetic-browser-session";
let signedIn = true;
let loginOutcome = "invalid";
let loginRequests = 0;
let checkoutKeys = [];
let history = [];
let ticket;
let failLogout = true;
let subscriptionState = "ACTIVE";
let accessRequests = 0;
let slowOverview = false;
let oauthEnabled = false;
let mailEnabled = true;
let productState;
let verifiedReads = 0;

const price = { amountMinor: 10000, currency: "RUB" };
const offer = { id: "offer-smoke", name: "MZT Smoke", durationMonths: 1, deviceLimit: 3, price };
const visualOffers = [offer, { ...offer, name: "MZT · 3 месяца", id: "offer-3", durationMonths: 3, deviceLimit: 5,
  price: { amountMinor: 27000, currency: "RUB" } }, { ...offer, name: "MZT · 6 месяцев", id: "offer-6", durationMonths: 6, deviceLimit: 7,
  price: { amountMinor: 49000, currency: "RUB" } }];
const snapshot = { ...offer, snapshottedAt: now, expiresAt: later };
const order = { id: "order-smoke", orderState: "OPEN", moneyStatus: "WAITING", deliveryStatus: "NOT_REQUESTED",
  createdAt: now, expiresAt: later, snapshot, allowedChannels: [], canStartPayment: false, refunds: [] };
const period = { id: "period-smoke", kind: "PURCHASE", deviceLimit: 3, startAt: now, endAt: later, effectiveEndAt: later, snapshot, adjustments: [] };
const page = items => ({ items, nextCursor: null });
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (!path.startsWith("/api/")) {
    const storefrontFiles = ["/manifest.webmanifest", "/mzt-sw.js", "/mzt-icon-192.png", "/mzt-icon-512.png"];
    const filename = path.startsWith("/assets/") || storefrontFiles.includes(path) ? join(dist, path) : join(dist, "index.html");
    try {
      serveAsset(req, res, mime[extname(filename)] ?? "application/octet-stream", filename, await readFile(filename), { pwa: true });
    } catch { res.writeHead(404).end(); }
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const json = (body, status = 200) => res.writeHead(status).end(JSON.stringify(body));
  if (path === "/api/config") {
    if (!productState) return json({}, 404);
    return json({ version: 1, product: { brandName: "Компания «Магазин связи» · Длинное название для проверки интерфейса",
      supportEmail: "support-team-with-long-address@example.invalid", legalTermsUrl: "https://example.invalid/terms",
      legalRefundUrl: "https://example.invalid/refunds", legalPrivacyUrl: "https://example.invalid/privacy" },
    availability: { registration: false, payments: false, support: false, maintenance: productState === "maintenance",
      google: false, telegram: false } });
  }
  if (path === "/api/auth/me") return signedIn ? json({ user, sessionId }) : json({ error: { code: "UNAUTHENTICATED" } }, 401);
  if (path === "/api/auth/login") {
    req.resume();
    loginRequests++;
    if (loginOutcome === "invalid") return json({ error: { code: "INVALID_CREDENTIALS" } }, 401);
    signedIn = loginOutcome === "confirmed";
    return json({ user, sessionId });
  }
  if (path === "/api/auth/refresh") return json({ error: { code: "INVALID_SESSION" } }, 401);
  if (path === "/api/auth/oauth/providers") return json({ providers: { google: oauthEnabled, telegram: oauthEnabled }, emailAvailable: mailEnabled });
  if (path === "/api/auth/register") {
    req.resume();
    return json({ ok: true, emailAvailable: mailEnabled, registrationReference: "b1d28ae0-4b81-483d-809f-a38d76b7e125" });
  }
  if (["/api/auth/forgot-password", "/api/auth/resend-verification"].includes(path)) { req.resume(); return json({ ok: true, emailAvailable: mailEnabled }); }
  if (["/api/auth/reset-password", "/api/auth/verify-email"].includes(path)) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks)).token, emailToken);
    return res.writeHead(204).end();
  }
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
  if (path === "/api/orders/order-smoke/payments") return json(page([{ id: "attempt-local", status: "UNKNOWN",
    updatedAt: now, confirmedCaptures: [] }]));
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
  if (path.endsWith("/read") && req.method === "POST") {
    req.resume();
    verifiedReads++;
    ticket.unread = 0;
    return res.writeHead(204).end();
  }
  if (path.startsWith("/api/me/support/cases") && req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { message, orderId, subject, action } = JSON.parse(Buffer.concat(chunks));
    if (action === "close") {
      ticket.status = "CLOSED";
      return json({ case: ticket });
    }
    ticket ??= { subject, unread: 1, id: "case-smoke", orderId, category: "PAYMENT", status: "OPEN", createdAt: now, updatedAt: now };
    const entry = { id: String(history.length), author: "CUSTOMER", text: message, createdAt: now };
    history = [entry, ...history];
    return json({ case: ticket, message: entry }, 201);
  }
  if (path === "/api/me/support/cases/case-smoke") return json({ case: ticket, readThrough: now, messages: page(history), history: page([]) });
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
    throw new Error("Missing expected UI state at " + await evaluate("location.pathname") + ": " + expression);
  }
  const text = value => "Boolean(document.body?.innerText.includes(" + JSON.stringify(value) + "))";
  const click = value => evaluate(`[...document.querySelectorAll("a,button")].find(e => e.getClientRects().length && (!document.querySelector("dialog[open]") || e.closest("dialog[open]")) && e.textContent.trim() === ${JSON.stringify(value)}).click()`);
  const menu = async value => {
    await evaluate('document.querySelector(`button[aria-label="Открыть меню"]`).click()');
    await until('Boolean(document.querySelector("dialog[open]"))');
    await click(value);
  };
  const fit = () => until("Boolean(document.documentElement && document.documentElement.scrollWidth <= innerWidth)");
  const fillAuth = values => evaluate(`for (const [name,value] of ${JSON.stringify(Object.entries(values))}) {
    const input = document.querySelector("[name=" + name + "]");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles:true}));
  }`);
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
  await until(text("Исход операции уточняется"));
  assert.ok(checkoutKeys[0] && checkoutKeys[0] === checkoutKeys[1]);
  await click("Помощь с заказом");
  await until(text("Новое обращение"));
  await fit();
  await evaluate('document.querySelector(`input[name="subject"]`).value = "Помощь с заказом для теста"');
  await evaluate(`document.querySelector("textarea").value = ${JSON.stringify(payload)}`);
  await click("Создать обращение");
  await until(text(payload));
  assert.equal(ticket.orderId, order.id);
  assert.equal(ticket.subject, "Помощь с заказом для теста");
  await until(text("Помощь с заказом для теста"));
  assert.equal(verifiedReads, 1);
  assert.equal(await evaluate("Boolean(window.__supportUnsafe || document.querySelector('.mzt-message img'))"), false);
  await evaluate(`
    const input = document.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Можно уточнить?");
    input.dispatchEvent(new Event("input", {bubbles:true}));
  `);
  await click("Отправить");
  await until(text("Можно уточнить?"));
  await click("Закрыть обращение");
  await click("Закрыть");
  await until(text("Обращение закрыто."));
  await fit();
  await menu("Безопасность");
  await until(text("Chromium Smoke"));
  await menu("Подключение");
  await until(text("Показать ссылку и QR"));
  await click("Показать ссылку и QR");
  await until('Boolean(document.querySelector("svg.mzt-qr path"))');
  await fit();
  await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await click("Копировать");
  await until(text("Скопировано."));
  const clipboard = await send("Runtime.evaluate", { expression: "navigator.clipboard.readText()", awaitPromise: true, returnByValue: true });
  assert.equal(clipboard.result.value, url);
  await send("Runtime.evaluate", { expression: "navigator.clipboard.writeText('')", awaitPromise: true });
  await click("Скрыть");
  await until("!document.querySelector('.mzt-qr, .mzt-private') && document.activeElement.textContent.includes('Показать ссылку и QR')");
  await click("Показать ссылку и QR");
  await until('Boolean(document.querySelector("svg.mzt-qr path"))');
  assert.ok(await evaluate(`[sessionStorage, localStorage].every(storage => !JSON.stringify(storage).includes(${JSON.stringify(url)}))`));
  assert.ok(requests.every(value => value.startsWith(origin) || value.startsWith("data:")));
  await evaluate('document.querySelector(`button[aria-label="Открыть меню"]`).click()');
  await click("Выйти");
  await until(text("Серверный выход ещё не подтверждён"));
  assert.ok(await evaluate("!document.querySelector('.mzt-account, .mzt-qr')"));
  await click("Повторить выход");
  await until("document.body && !document.body.innerText.includes('Серверный выход ещё не подтверждён')");
  assert.equal(signedIn, false);
  await until('navigator.serviceWorker && Boolean(document.querySelector("link[rel=manifest]"))');
  const worker = await send("Runtime.evaluate", { expression: `Promise.all([
    Promise.race([navigator.serviceWorker.ready.then(registration => registration.active?.scriptURL),
      new Promise(resolve => setTimeout(() => resolve(null), 3500))]),
    caches.keys()
  ])`, awaitPromise: true, returnByValue: true });
  assert.deepEqual(worker.result.value, [origin + "/mzt-sw.js", []]);

  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 440, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: origin + "/login" });
  await until(text("Войти в кабинет"));
  assert.equal(await evaluate('Boolean(document.querySelector("[name=password]"))'), false);
  await fillAuth({ email: "synthetic@example.invalid" });
  await click("Продолжить");
  await until('document.activeElement.name === "password"');
  assert.equal(loginRequests, 0);
  await fillAuth({ password: "not-a-real-password" });
  assert.ok(await evaluate(`(() => {
    const button = document.querySelector(".auth-form button[type='submit']");
    button.scrollIntoView({block:"center"});
    const rect = button.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })()`));
  await click("Войти");
  await until(text("Неверный email или пароль"));
  assert.equal(await evaluate('Boolean(document.querySelector(".mz-maze-opening"))'), false);
  loginOutcome = "unconfirmed";
  await click("Войти");
  await until(text("Войдите, чтобы подключить аккаунт"));
  assert.equal(await evaluate('Boolean(document.querySelector(".mz-maze-opening"))'), false);
  loginOutcome = "confirmed";
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await click("Войти");
  await until('Boolean(document.querySelector(".mz-maze-opening"))');
  await until("location.pathname.startsWith('/account')");
  assert.equal(await evaluate("localStorage.getItem('mzt.last-sign-in-method')"), "email");
  assert.equal(await evaluate('Boolean(document.querySelector(".mz-maze-opening"))'), false);
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await send("Page.navigate", { url: origin + "/account?signed-in-with=google" });
  await until("location.search === '' && Boolean(document.querySelector('.mzt-account'))");
  assert.equal(await evaluate("localStorage.getItem('mzt.last-sign-in-method')"), "google");
  assert.equal(await evaluate('Boolean(document.querySelector(".mz-maze-opening"))'), false);
  signedIn = false;
  await fit();
  const password = "local-test-password";
  oauthEnabled = true;
  await send("Page.navigate", { url: origin + "/login?error=OAUTH_DENIED" });
  await until("Boolean(document.querySelector('.oauth__buttons a'))");
  assert.ok(await evaluate("location.search === '' && Boolean(document.querySelector('[role=alert]'))"));
  assert.ok(await evaluate("[...document.querySelectorAll('.oauth__buttons a')].every(a => a.origin === location.origin && a.pathname.endsWith('/start'))"));
  oauthEnabled = false;
  await send("Page.navigate", { url: origin + "/register" });
  await until(text("Создать аккаунт"));
  await fillAuth({ email: "synthetic@example.invalid", password, confirmPassword: "different-password" });
  await click("Создать аккаунт");
  await until(text("Пароли не совпадают"));
  await fillAuth({ confirmPassword: password });
  await click("Создать аккаунт");
  await until(text("Заявка на регистрацию"));
  await until(text("b1d28ae0-4b81-483d-809f-a38d76b7e125"));
  await send("Page.navigate", { url: origin + "/forgot-password" });
  await until(text("Отправить ссылку"));
  await fillAuth({ email: "synthetic@example.invalid" });
  await click("Отправить ссылку");
  await until(text("Проверьте почту"));
  await send("Page.navigate", { url: origin + "/verify-email#token=" + emailToken });
  await until(text("Почта подтверждена"));
  assert.equal(await evaluate("location.search + location.hash"), "");
  await send("Page.navigate", { url: origin + "/reset-password#token=" + emailToken });
  await until(text("Сохранить пароль"));
  assert.equal(await evaluate("location.search + location.hash"), "");
  await fillAuth({ password, confirmPassword: password });
  await click("Сохранить пароль");
  await until(text("Пароль изменён"));
  mailEnabled = false;
  await send("Page.navigate", { url: origin + "/activation" });
  await until(text("Автоматические письма сейчас недоступны"));
  await send("Page.navigate", { url: origin + "/forgot-password" });
  await until(text("Автоматический сброс по почте сейчас недоступен"));
  mailEnabled = true;
  signedIn = true;
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  slowOverview = true;
  await send("Page.navigate", { url: origin + "/account" });
  await until('Boolean(document.querySelector("main .mz-skeleton"))');
  assert.equal(await evaluate(text("Последние заказы")), false);
  await until(text("Активная подписка"));
  await until(text("Последние заказы"));
  slowOverview = false;
  for (const [state, expected] of [["EMPTY", "Нет подписки"], ["EXPIRED", "Подписка истекла"], ["ERROR", "Действие не завершилось"]]) {
    subscriptionState = state;
    await send("Page.navigate", { url: origin + "/account" });
    await until(text(expected));
    assert.equal(await evaluate(text("Показать ссылку и QR")), false);
    await fit();
  }
  subscriptionState = "ACTIVE";
  assert.equal(accessRequests, 2);
  console.log("Chromium 360 px: checkout retry and UNKNOWN, support, local QR/copy/hide/logout, account states, auth validation/OAuth/registration/verify/reset passed");
  if (process.env.MZT_VISUAL_DIR) {
    history = [{ id: "staff-response", author: "STAFF", text: "Уточните, пожалуйста, время оплаты.", createdAt: now },
      ...history.filter(entry => entry.text !== payload)];
    ticket.status = "WAITING_CUSTOMER";
    await visualQa({ site: "web", dist, send, evaluate, until, origin,
      prepare: screen => {
        signedIn = !screen.guest;
        oauthEnabled = Boolean(screen.oauth);
        mailEnabled = !screen.noMail;
        productState = screen.product;
        if (screen.id === "support") ticket.unread = 1;
      },
      afterLoad: async screen => {
        if (screen.id === "initial-password") {
          await fillAuth({ email: "synthetic@example.invalid" });
          await click("Продолжить");
          await click("У меня временный пароль");
          await until(text("Сменить пароль"));
        } else {
          await click("Выбрать");
          await until(text("Проверьте условия"));
        }
      },
      screens: [
        { id: "login", path: "/login", ready: "Войти в кабинет", guest: true, measure: true },
        { id: "initial-password", path: "/login", ready: "Войти в кабинет", guest: true, afterLoad: true },
        { id: "maintenance", path: "/maintenance", ready: "Техническое обслуживание", guest: true, product: "maintenance" },
        { id: "registration-closed", path: "/register", ready: "Регистрация закрыта", guest: true, product: "closed" },
        { id: "payments-closed", path: "/account/plans", ready: "Покупка временно недоступна", product: "closed" },
        { id: "support-closed", path: "/account/support", ready: "Приём новых обращений временно прекращён", product: "closed" },
        { id: "register", path: "/register", ready: "Пароль", guest: true },
        { id: "forgot-password", path: "/forgot-password", ready: "Отправить ссылку", guest: true },
        { id: "activation-pending", path: "/activation", ready: "ручной активации", guest: true, noMail: true },
        { id: "verify-email", path: "/verify-email#token=" + emailToken, ready: "Почта подтверждена", guest: true },
        { id: "reset-password", path: "/reset-password#token=" + emailToken, ready: "Сохранить пароль", guest: true },
        { id: "oauth-login", path: "/login?error=OAUTH_DENIED", ready: "Google", guest: true, oauth: true },
        { id: "not-found", path: "/page-not-found", ready: "Страница не найдена", guest: true },
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
