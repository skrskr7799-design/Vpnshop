import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { OAuthProvider } from "./oauth.types";

const HTTP_TIMEOUT_MS = 10_000;

export function buildAuthorizationUrl(
  provider: OAuthProvider,
  params: { redirectUri: string; state: string; codeChallenge: string; nonce?: string },
): string {
  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (provider.useNonce && params.nonce) url.searchParams.set("nonce", params.nonce);
  return url.toString();
}

// Обмен кода на токены: серверный запрос с секретом клиента и PKCE-verifier.
export async function exchangeCode(
  provider: OAuthProvider,
  params: { redirectUri: string; code: string; codeVerifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    client_id: provider.clientId,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (provider.tokenAuth === "basic") {
    headers.Authorization = `Basic ${Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_secret", provider.clientSecret);
  }

  const res = await fetch(provider.tokenUrl, {
    method: "POST",
    redirect: "error",
    headers,
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  // Тело ответа не включаем в ошибку: оно может содержать лишнее
  if (!res.ok) throw new Error(`token endpoint responded with ${res.status}`);

  const json = (await res.json()) as { id_token?: unknown };
  if (typeof json.id_token !== "string") throw new Error("token response has no id_token");
  return json.id_token;
}

// JWKS кэшируется на процесс (jose сам обновляет ключи при ротации)
const remoteKeys = new Map<string, JWTVerifyGetKey>();
function keysFor(jwksUrl: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(jwksUrl);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: HTTP_TIMEOUT_MS });
    remoteKeys.set(jwksUrl, keys);
  }
  return keys;
}

// Проверка id_token: подпись, issuer, audience, срок действия, алгоритм и nonce.
export async function verifyIdToken(
  provider: OAuthProvider,
  idToken: string,
  opts: { nonce?: string; keys?: JWTVerifyGetKey } = {},
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(idToken, opts.keys ?? keysFor(provider.jwksUrl), {
    issuer: provider.issuers,
    audience: provider.clientId,
    algorithms: provider.algorithms,
    requiredClaims: ["sub", "exp", "iat", ...(provider.useNonce ? ["nonce"] : [])],
    clockTolerance: 60,
  });
  if (typeof payload.iat !== "number" || payload.iat > Date.now() / 1000 + 60) throw new Error("Invalid ID token issue time");
  if (!payload.sub) throw new Error("id_token has no sub");
  if (provider.useNonce && (!opts.nonce || payload.nonce !== opts.nonce)) throw new Error("nonce mismatch");
  return payload;
}
