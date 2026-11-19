import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../lib/errors";
import { signAccessToken } from "../auth/jwt";
import { flowCookieName } from "./flow-cookie";
import { loginWithProfile, linkProfile } from "./oauth.service";
import { oauthRoutes } from "./oauth.routes";
import { createGoogleProvider } from "./providers/google";
import { createTelegramProvider } from "./providers/telegram";
import { createSession } from "../auth/session.service";

// БД и сессии подменяем: проверяем именно протокол и обработку callback
vi.mock("./oauth.service", () => ({
  loginWithProfile: vi.fn(),
  linkProfile: vi.fn(),
  listLinkedProviders: vi.fn(),
}));
vi.mock("../auth/session.service", () => ({ createSession: vi.fn() }));

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

beforeEach(() => {
  idp.tokenRequests = [];
  vi.mocked(loginWithProfile).mockReset().mockResolvedValue({ id: "user-1", role: "USER" } as never);
  vi.mocked(linkProfile).mockReset().mockResolvedValue(undefined);
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

describe("привязка к вошедшему пользователю", () => {
  it("без авторизации отправляет на вход", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/oauth/google/link" });
    expect(location(res)).toBe("http://localhost:5173/login?error=UNAUTHENTICATED");
  });

  it("привязывает внешний аккаунт, не создавая новую сессию", async () => {
    idp.idToken = googleToken();
    const access = await signAccessToken({ userId: "user-42", role: "USER" });
    const flow = await start(app, "google", { cookies: {} });
    // старт в режиме link
    const res0 = await app.inject({ method: "GET", url: "/api/auth/oauth/google/link", cookies: { vpn_at: access } });
    expect(res0.statusCode).toBe(302);
    const url = new URL(location(res0));
    idp.challenge = url.searchParams.get("code_challenge")!;
    (idp as unknown as { nonce: string | null }).nonce = url.searchParams.get("nonce");
    const cookies = Object.fromEntries(res0.cookies.map((c) => [c.name, c.value]));
    void flow;

    const res = await callback(app, "google", `code=abc&state=${url.searchParams.get("state")}`, cookies);

    expect(location(res)).toBe("http://localhost:5173/account?linked=google");
    expect(linkProfile).toHaveBeenCalledWith("user-42", "GOOGLE", {
      providerId: "g-sub",
      email: "user@gmail.com",
      emailVerified: true,
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(loginWithProfile).not.toHaveBeenCalled();
  });

  it("конфликт привязки возвращает на /account с кодом ошибки", async () => {
    idp.idToken = googleToken();
    vi.mocked(linkProfile).mockRejectedValue(new AppError(409, "IDENTITY_TAKEN"));
    const access = await signAccessToken({ userId: "user-42", role: "USER" });
    const res0 = await app.inject({ method: "GET", url: "/api/auth/oauth/google/link", cookies: { vpn_at: access } });
    const url = new URL(location(res0));
    idp.challenge = url.searchParams.get("code_challenge")!;
    (idp as unknown as { nonce: string | null }).nonce = url.searchParams.get("nonce");
    const cookies = Object.fromEntries(res0.cookies.map((c) => [c.name, c.value]));

    const res = await callback(app, "google", `code=abc&state=${url.searchParams.get("state")}`, cookies);
    expect(location(res)).toBe("http://localhost:5173/account?error=IDENTITY_TAKEN");
  });
});
