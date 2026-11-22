import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { resetDatabase } from "../../test/db";
import { createUser } from "../../test/factories";
import { signAccessToken } from "../auth/jwt";
import { flowCookieName } from "./flow-cookie";
import { loginWithProfile, linkProfile } from "./oauth.service";
import { oauthRoutes } from "./oauth.routes";
import { createGoogleProvider } from "./providers/google";
import { createTelegramProvider } from "./providers/telegram";
import { createSession } from "../auth/session.service";

// БД и сессии подменяем: проверяем именно протокол и обработку callback
vi.mock("./oauth.service", async importOriginal => {
  const original = await importOriginal<typeof import("./oauth.service")>();
  return { ...original, loginWithProfile: vi.fn(original.loginWithProfile), linkProfile: vi.fn(original.linkProfile) };
});
vi.mock("../auth/session.service", async importOriginal => {
  const original = await importOriginal<typeof import("../auth/session.service")>();
  return { ...original, createSession: vi.fn() };
});

// ───────── Фейковый провайдер: token endpoint + JWKS ─────────
type TokenRequest = { authorization?: string; body: URLSearchParams };
const idp = {
  server: undefined as unknown as Server,
  base: "",
  privateKey: undefined as unknown as Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  jwk: undefined as unknown as JWK,
  challenge: "", // code_challenge из последнего authorize-запроса
  tokenRequests: [] as TokenRequest[],
  // что положить в id_token
  idToken: (_nonce: string | null) => Promise.resolve(""),
};

const readBody = (req: import("node:http").IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  idp.privateKey = pair.privateKey;
  idp.jwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig" };

  idp.server = createServer(async (req, res) => {
    if (req.url === "/jwks") {
      res.setHeader("Content-Type", "application/json").end(JSON.stringify({ keys: [idp.jwk] }));
      return;
    }
    if (req.url === "/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      idp.tokenRequests.push({ authorization: req.headers.authorization, body });
      // Настоящий провайдер сверяет PKCE: проверяем, что verifier соответствует challenge
      const verifier = body.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== idp.challenge) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const nonce = (idp as unknown as { nonce: string | null }).nonce;
      res.setHeader("Content-Type", "application/json").end(JSON.stringify({ id_token: await idp.idToken(nonce) }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => idp.server.listen(0, "127.0.0.1", resolve));
  idp.base = `http://127.0.0.1:${(idp.server.address() as AddressInfo).port}`;
});
afterAll(() => idp.server.close());

const signToken = (claims: Record<string, unknown>, iss: string, aud: string) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(idp.privateKey);

// ───────── Приложение ─────────
let app: FastifyInstance;

beforeAll(async () => {
  const endpoints = { tokenUrl: `${idp.base}/token`, jwksUrl: `${idp.base}/jwks` };
  const providers = new Map([
    ["google" as const, createGoogleProvider({ clientId: "g-client", clientSecret: "g-secret" }, endpoints)],
  ]);
  app = Fastify();
  await app.register(cookie, { secret: process.env.COOKIE_SECRET! });
  await app.register(oauthRoutes, { prefix: "/api/auth/oauth", providers });
  await app.ready();
});
afterAll(() => app.close());

// Второй экземпляр с Telegram
let tgApp: FastifyInstance;
beforeAll(async () => {
  const endpoints = { tokenUrl: `${idp.base}/token`, jwksUrl: `${idp.base}/jwks` };
  const providers = new Map([
    ["telegram" as const, createTelegramProvider({ clientId: "123456789", clientSecret: "tg-secret" }, endpoints)],
  ]);
  tgApp = Fastify();
  await tgApp.register(cookie, { secret: process.env.COOKIE_SECRET! });
  await tgApp.register(oauthRoutes, { prefix: "/api/auth/oauth", providers });
  await tgApp.ready();
});
afterAll(() => tgApp.close());

beforeEach(async () => {
  await resetDatabase();
  idp.tokenRequests = [];
  vi.mocked(loginWithProfile).mockReset();
  vi.mocked(linkProfile).mockReset();
  vi.mocked(createSession).mockReset().mockResolvedValue({ accessToken: "AT", refreshToken: "RT" });
});

// ───────── Помощники ─────────
type StartResult = { state: string; nonce: string | null; cookies: Record<string, string>; authorizeUrl: URL };

async function start(
  server: FastifyInstance,
  provider: "google" | "telegram",
  opts: { query?: string; cookies?: Record<string, string> } = {},
): Promise<StartResult> {
  const res = await server.inject({
    method: "GET",
    url: `/api/auth/oauth/${provider}/start${opts.query ?? ""}`,
    cookies: opts.cookies,
  });
  expect(res.statusCode).toBe(302);
  const authorizeUrl = new URL(res.headers.location as string);
  idp.challenge = authorizeUrl.searchParams.get("code_challenge")!;
  const nonce = authorizeUrl.searchParams.get("nonce");
  (idp as unknown as { nonce: string | null }).nonce = nonce;
  return {
    state: authorizeUrl.searchParams.get("state")!,
    nonce,
    cookies: Object.fromEntries(res.cookies.map((c) => [c.name, c.value])),
    authorizeUrl,
  };
}

const callback = (server: FastifyInstance, provider: string, query: string, cookies?: Record<string, string>) =>
  server.inject({ method: "GET", url: `/api/auth/oauth/${provider}/callback?${query}`, cookies });

const googleToken =
  (extra: Record<string, unknown> = {}, aud = "g-client") =>
  (nonce: string | null) =>
    signToken({ sub: "g-sub", email: "User@Gmail.com", email_verified: true, nonce, ...extra }, "https://accounts.google.com", aud);

const location = (res: { headers: Record<string, unknown> }) => String(res.headers.location);

// ───────── Тесты ─────────
describe("старт входа", () => {
  it("редиректит на провайдера с PKCE/state/nonce и ставит подписанную httpOnly-куку", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/oauth/google/start" });
    expect(res.statusCode).toBe(302);
    const url = new URL(location(res));
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/auth/oauth/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();

    const flowCookie = res.cookies.find((c) => c.name === flowCookieName("google"));
    expect(flowCookie).toMatchObject({ httpOnly: true, path: "/api/auth/oauth", sameSite: "Lax" });
    // секреты (verifier) не должны попасть в URL
    expect(location(res)).not.toContain("code_verifier");
  });

  it("отключённый провайдер даёт 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/oauth/telegram/start" });
    expect(res.statusCode).toBe(404);
  });
});

describe("Google: вход", () => {
  it("полный поток: обмен кода с PKCE, проверка id_token, сессия и редирект", async () => {
    idp.idToken = googleToken();
    const flow = await start(app, "google");

    const res = await callback(app, "google", `code=abc&state=${flow.state}`, flow.cookies);

    expect(location(res)).toBe("http://localhost:5173/account");
    expect(loginWithProfile).toHaveBeenCalledWith("GOOGLE", {
      providerId: "g-sub",
      email: "user@gmail.com",
      emailVerified: true,
    });
    expect(createSession).toHaveBeenCalledOnce();

    const setCookies = ([] as string[]).concat((res.headers["set-cookie"] as string[]) ?? []);
    expect(setCookies.some((c) => c.startsWith("vpn_at=AT") && c.includes("HttpOnly"))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("vpn_rt=RT") && c.includes("Path=/api/auth"))).toBe(true);
    // кука потока стирается
    expect(setCookies.some((c) => c.startsWith(`${flowCookieName("google")}=;`))).toBe(true);

    // на token endpoint ушёл секрет в теле и нет Basic-заголовка
    const tokenRequest = idp.tokenRequests[0]!;
    expect(tokenRequest.body.get("client_secret")).toBe("g-secret");
    expect(tokenRequest.body.get("grant_type")).toBe("authorization_code");
    expect(tokenRequest.authorization).toBeUndefined();
  });

  it("возвращает на сохранённую страницу и игнорирует внешний returnTo", async () => {
    idp.idToken = googleToken();
    const good = await start(app, "google", { query: "?returnTo=/orders%3Fa%3D1" });
    const ok = await callback(app, "google", `code=abc&state=${good.state}`, good.cookies);
    expect(location(ok)).toBe("http://localhost:5173/orders?a=1");

    const evil = await start(app, "google", { query: "?returnTo=//evil.example" });
    const res = await callback(app, "google", `code=abc&state=${evil.state}`, evil.cookies);
    expect(location(res)).toBe("http://localhost:5173/account");
  });

  it("does not replace a live account when a guest callback arrives after another login", async () => {
    idp.idToken = googleToken();
    const flow = await start(app, "google");
    const user = await createUser();
    const claims = { userId: user.id, role: "USER" as const, sid: randomUUID() };
    await prisma.sessionFamily.create({ data: {
      id: claims.sid, userId: user.id, expiresAt: new Date(Date.now() + 60_000),
    } });
    const token = await signAccessToken(claims);
    const reply = await callback(app, "google", `code=abc&state=${flow.state}`, { ...flow.cookies, vpn_at: token });
    expect(location(reply)).toBe("http://localhost:5173/login?error=ALREADY_SIGNED_IN");
    expect(idp.tokenRequests).toHaveLength(0);
  });

  it("неверный state: отказ без обращения к провайдеру", async () => {
    idp.idToken = googleToken();
    const flow = await start(app, "google");
    const res = await callback(app, "google", "code=abc&state=forged", flow.cookies);
    expect(location(res)).toBe("http://localhost:5173/login?error=OAUTH_STATE");
    expect(idp.tokenRequests).toHaveLength(0);
    expect(loginWithProfile).not.toHaveBeenCalled();
  });

  it("без куки потока (повтор ссылки, чужой браузер): OAUTH_STATE", async () => {
    const res = await callback(app, "google", "code=abc&state=whatever");
    expect(location(res)).toBe("http://localhost:5173/login?error=OAUTH_STATE");
    expect(idp.tokenRequests).toHaveLength(0);
  });

  it("поддельная кука потока не принимается", async () => {
    const flow = await start(app, "google");
    const forged = { [flowCookieName("google")]: flow.cookies[flowCookieName("google")]!.replace(/.$/, "x") };
    const res = await callback(app, "google", `code=abc&state=${flow.state}`, forged);
    expect(location(res)).toBe("http://localhost:5173/login?error=OAUTH_STATE");
  });

  it("пользователь отказал на стороне провайдера: OAUTH_DENIED", async () => {
    const flow = await start(app, "google");
    const res = await callback(app, "google", `error=access_denied&state=${flow.state}`, flow.cookies);
    expect(location(res)).toBe("http://localhost:5173/login?error=OAUTH_DENIED");
  });

  it("токен для другой аудитории отклоняется", async () => {
    idp.idToken = googleToken({}, "someone-else");
    const flow = await start(app, "google");
    const res = await callback(app, "google", `code=abc&state=${flow.state}`, flow.cookies);
    expect(location(res)).toBe("http://localhost:5173/login?error=OAUTH_FAILED");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("токен с чужим nonce отклоняется (replay)", async () => {
    idp.idToken = googleToken({ nonce: "replayed" });
    const flow = await start(app, "google");
    const res = await callback(app, "google", `code=abc&state=${flow.state}`, flow.cookies);
    expect(location(res)).toBe("http://localhost:5173/login?error=OAUTH_FAILED");
  });

  it("если провайдер отверг код (например, verifier не совпал), вход не происходит", async () => {
    idp.idToken = googleToken();
    const flow = await start(app, "google");
    idp.challenge = "another-challenge"; // имитируем несовпадение PKCE
    const res = await callback(app, "google", `code=abc&state=${flow.state}`, flow.cookies);
    expect(location(res)).toBe("http://localhost:5173/login?error=OAUTH_FAILED");
  });

  it("ошибки бизнес-логики уходят на фронт кодом", async () => {
    idp.idToken = googleToken();
    vi.mocked(loginWithProfile).mockRejectedValue(new AppError(403, "ACCOUNT_BLOCKED"));
    const flow = await start(app, "google");
    const res = await callback(app, "google", `code=abc&state=${flow.state}`, flow.cookies);
    expect(location(res)).toBe("http://localhost:5173/login?error=ACCOUNT_BLOCKED");
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("Telegram: вход", () => {
  it("Basic-авторизация на token endpoint и Telegram id из клэйма id", async () => {
    idp.idToken = () => signToken({ sub: "1234123412341234123", id: 987654321, name: "Roman" }, "https://oauth.telegram.org", "123456789");
    const flow = await start(tgApp, "telegram");
    expect(flow.authorizeUrl.searchParams.get("scope")).toBe("openid profile");
    expect(flow.nonce).toBeNull();

    const res = await callback(tgApp, "telegram", `code=abc&state=${flow.state}`, flow.cookies);

    expect(location(res)).toBe("http://localhost:5173/account");
    expect(loginWithProfile).toHaveBeenCalledWith("TELEGRAM", { providerId: "987654321", email: null, emailVerified: false });
    const tokenRequest = idp.tokenRequests[0]!;
    expect(tokenRequest.authorization).toBe(`Basic ${Buffer.from("123456789:tg-secret").toString("base64")}`);
    expect(tokenRequest.body.get("client_secret")).toBeNull();
  });

  it("без клэйма id (профиль не передан) вход отклоняется", async () => {
    idp.idToken = () => signToken({ sub: "1234123412341234123" }, "https://oauth.telegram.org", "123456789");
    const flow = await start(tgApp, "telegram");
    const res = await callback(tgApp, "telegram", `code=abc&state=${flow.state}`, flow.cookies);
    expect(location(res)).toBe("http://localhost:5173/login?error=TELEGRAM_PROFILE_MISSING");
  });
});

async function prepareLink() {
  const user = await prisma.user.create({ data: {} });
  const sid = randomUUID();
  await prisma.sessionFamily.create({ data: { id: sid, userId: user.id, expiresAt: new Date(Date.now() + 180000) } });
  const proof = await prisma.identityProof.create({ data: { familyId: sid, target: "GOOGLE", purpose: "LINK",
    expiresAt: new Date(Date.now() + 180000) } });
  const access = await signAccessToken({ userId: user.id, role: "USER", sid });
  const begin = await app.inject({ method: "POST", url: "/api/auth/oauth/google/link", cookies: { vpn_at: access },
    headers: { "idempotency-key": randomUUID() }, payload: { confirmationId: proof.id } });
  expect(begin.statusCode).toBe(200);
  const url = new URL(begin.json().authorizeUrl);
  idp.challenge = url.searchParams.get("code_challenge")!;
  (idp as unknown as { nonce: string | null }).nonce = url.searchParams.get("nonce");
  return {
    sid, user, query: `code=abc&state=${url.searchParams.get("state")}`,
    cookies: { vpn_at: access, ...Object.fromEntries(begin.cookies.map(c => [c.name, c.value])) },
  };
}

it("binds exactly once even if both callbacks carry the original browser cookie", async () => {
  idp.idToken = googleToken();
  const flow = await prepareLink();
  const responses = await Promise.all([callback(app, "google", flow.query, flow.cookies), callback(app, "google", flow.query, flow.cookies)]);
  expect(responses.map(location).sort()).toEqual([
    "http://localhost:5173/account/security?linked=google", "http://localhost:5173/login?error=OAUTH_STATE",
  ]);
  expect(idp.tokenRequests).toHaveLength(1);
  expect(await prisma.authIdentity.count({ where: { userId: flow.user.id } })).toBe(1);
  expect(createSession).not.toHaveBeenCalled();
});

it("refuses a stale callback after family revoke and rejects legacy GET link", async () => {
  const flow = await prepareLink();
  await prisma.sessionFamily.update({ where: { id: flow.sid }, data: { revokedAt: new Date() } });
  const response = await callback(app, "google", flow.query, flow.cookies);
  expect(location(response)).toBe("http://localhost:5173/account/security?error=UNAUTHENTICATED");
  expect(idp.tokenRequests).toHaveLength(0);
  expect((await app.inject({ url: "/api/auth/oauth/google/link" })).statusCode).toBe(404);
});
