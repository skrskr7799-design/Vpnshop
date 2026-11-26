import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildAuthorizationUrl, exchangeCode, verifyIdToken } from "./oidc";
import { createGoogleProvider } from "./providers/google";
import { createTelegramProvider } from "./providers/telegram";

const google = createGoogleProvider({ clientId: "google-client", clientSecret: "secret" });
const telegram = createTelegramProvider({ clientId: "123456789", clientSecret: "secret" });

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig" };
  keys = createLocalJWKSet({ keys: [jwk] });
});

type Claims = Record<string, unknown>;
const sign = (claims: Claims, opts: { iss?: string; aud?: string; exp?: string | number; alg?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "RS256" })
    .setSubject("user-1")
    .setIssuer(opts.iss ?? "https://accounts.google.com")
    .setAudience(opts.aud ?? "google-client")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);

describe("buildAuthorizationUrl", () => {
  it("содержит PKCE, state, scope и nonce для Google", () => {
    const url = new URL(
      buildAuthorizationUrl(google, { redirectUri: "https://x.test/cb", state: "st", codeChallenge: "ch", nonce: "nn" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "google-client",
      redirect_uri: "https://x.test/cb",
      response_type: "code",
      scope: "openid email",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
      nonce: "nn",
    });
  });

  it("не передаёт nonce Telegram", () => {
    const url = new URL(
      buildAuthorizationUrl(telegram, { redirectUri: "https://x.test/cb", state: "st", codeChallenge: "ch", nonce: "nn" }),
    );
    expect(url.searchParams.has("nonce")).toBe(false);
    expect(url.searchParams.get("scope")).toBe("openid profile");
  });
});

it("rejects non-success OAuth token responses and disables redirect following", async () => {
  const tokenEndpoint = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 307 }));
  vi.stubGlobal("fetch", tokenEndpoint);
  try {
    await expect(exchangeCode(google, { code: "synthetic", codeVerifier: "synthetic", redirectUri: "https://mzt.example.invalid/callback" }))
      .rejects.toThrow(/token endpoint/);
    expect(tokenEndpoint).toHaveBeenCalledOnce();
    expect(tokenEndpoint.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error" });
  } finally { vi.unstubAllGlobals(); }
});

describe("verifyIdToken", () => {
  it("принимает корректный токен", async () => {
    const token = await sign({ nonce: "n1", email: "a@b.co" });
    const payload = await verifyIdToken(google, token, { nonce: "n1", keys });
    expect(payload.sub).toBe("user-1");
  });

  it("requires an expiration claim in a signed ID token", async () => {
    const incomplete = await new SignJWT({ nonce: "n1" }).setProtectedHeader({ alg: "RS256" }).setSubject("fixture-user")
      .setIssuer("https://accounts.google.com").setAudience("google-client").setIssuedAt().sign(privateKey);
    await expect(verifyIdToken(google, incomplete, { nonce: "n1", keys })).rejects.toThrow();
  });

  it("requires a server nonce for providers using nonce", async () => {
    await expect(verifyIdToken(google, await sign({ nonce: "n1" }), { keys })).rejects.toThrow("nonce");
  });

  it("отклоняет чужую аудиторию", async () => {
    const token = await sign({ nonce: "n1" }, { aud: "other-client" });
    await expect(verifyIdToken(google, token, { nonce: "n1", keys })).rejects.toThrow();
  });

  it("отклоняет чужого издателя", async () => {
    const token = await sign({ nonce: "n1" }, { iss: "https://evil.example" });
    await expect(verifyIdToken(google, token, { nonce: "n1", keys })).rejects.toThrow();
  });

  it("отклоняет истёкший токен", async () => {
    const token = await sign({ nonce: "n1" }, { exp: Math.floor(Date.now() / 1000) - 3600 });
    await expect(verifyIdToken(google, token, { nonce: "n1", keys })).rejects.toThrow();
  });

  it("отклоняет неверный nonce", async () => {
    const token = await sign({ nonce: "other" });
    await expect(verifyIdToken(google, token, { nonce: "n1", keys })).rejects.toThrow("nonce");
  });

  it("отклоняет токен, подписанный чужим ключом", async () => {
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ nonce: "n1" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user-1")
      .setIssuer("https://accounts.google.com")
      .setAudience("google-client")
      .setExpirationTime("5m")
      .sign(other.privateKey);
    await expect(verifyIdToken(google, forged, { nonce: "n1", keys })).rejects.toThrow();
  });

  it("отклоняет алгоритм none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: "x", iss: "https://accounts.google.com", aud: "google-client", exp: 9999999999, nonce: "n1" }),
    ).toString("base64url");
    await expect(verifyIdToken(google, `${header}.${body}.`, { nonce: "n1", keys })).rejects.toThrow();
  });

  it("Telegram: принимает токен без nonce, с aud равным id бота", async () => {
    const token = await sign({ id: 987654321 }, { iss: "https://oauth.telegram.org", aud: "123456789" });
    const payload = await verifyIdToken(telegram, token, { keys });
    expect(payload.id).toBe(987654321);
  });
});

describe("toProfile", () => {
  it("Google: email_verified должен быть именно true", () => {
    expect(google.toProfile({ sub: "s", email: " User@Gmail.com ", email_verified: true })).toEqual({
      providerId: "s",
      email: "user@gmail.com",
      emailVerified: true,
    });
    expect(google.toProfile({ sub: "s", email: "u@gmail.com", email_verified: "true" }).emailVerified).toBe(false);
    expect(google.toProfile({ sub: "s" })).toEqual({ providerId: "s", email: null, emailVerified: false });
  });

  it("Telegram: берёт id из клэйма id, а не sub", () => {
    expect(telegram.toProfile({ sub: "1234123412341234123", id: 987654321 }).providerId).toBe("987654321");
  });

  it("Telegram: без клэйма id вход невозможен", () => {
    expect(() => telegram.toProfile({ sub: "1" })).toThrow();
  });
});
