import { timingSafeEqual } from "node:crypto";
import type { OAuthProviderId } from "@vpn/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../config/env";
import { generateToken } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { ACCESS_COOKIE } from "../auth/auth.constants";
import { authenticate } from "../auth/authenticate";
import { setAuthCookies } from "../auth/cookies";
import { verifyAccessToken } from "../auth/jwt";
import { createSession } from "../auth/session.service";
import { clearFlowCookie, readFlowCookie, setFlowCookie, type OAuthFlow } from "./flow-cookie";
import { buildAuthorizationUrl, exchangeCode, verifyIdToken } from "./oidc";
import { linkProfile, listLinkedProviders, loginWithProfile } from "./oauth.service";
import type { OAuthProvider, ProviderMap } from "./oauth.types";
import { codeChallengeFromVerifier, generateCodeVerifier } from "./pkce";
import { sanitizeReturnTo } from "./return-to";

const limit = (max: number, timeWindow: string) => ({ config: { rateLimit: { max, timeWindow } } });

const callbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(200).optional(),
});

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const redirectUriFor = (provider: OAuthProvider): string =>
  new URL(`/api/auth/oauth/${provider.id}/callback`, env.WEB_ORIGIN).toString();

// Редирект на страницу фронта. Ошибка идёт кодом из белого списка, без деталей.
const toWeb = (reply: FastifyReply, path: string, query: Record<string, string> = {}) => {
  const url = new URL(path, env.WEB_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return reply.redirect(url.toString());
};

export const oauthRoutes: FastifyPluginAsync<{ providers: ProviderMap }> = async (app, { providers }) => {
  const resolveProvider = (req: FastifyRequest): OAuthProvider => {
    const id = (req.params as { provider: string }).provider as OAuthProviderId;
    const provider = providers.get(id);
    if (!provider) throw new AppError(404, "PROVIDER_DISABLED");
    return provider;
  };

  function begin(req: FastifyRequest, reply: FastifyReply, provider: OAuthProvider, intent: OAuthFlow["intent"]) {
    const returnTo = sanitizeReturnTo((req.query as { returnTo?: unknown }).returnTo);
    const flow: OAuthFlow = {
      state: generateToken(),
      codeVerifier: generateCodeVerifier(),
      nonce: provider.useNonce ? generateToken() : undefined,
      returnTo,
      intent,
    };
    setFlowCookie(reply, provider.id, flow);
    return reply.redirect(
      buildAuthorizationUrl(provider, {
        redirectUri: redirectUriFor(provider),
        state: flow.state,
        codeChallenge: codeChallengeFromVerifier(flow.codeVerifier),
        nonce: flow.nonce,
      }),
    );
  }

  // Какие кнопки показывать на фронте
  app.get("/providers", async () => ({
    providers: { google: providers.has("google"), telegram: providers.has("telegram") },
  }));

  // Какие способы входа уже подключены у текущего пользователя
  app.get("/identities", { preHandler: authenticate }, async (req) => ({
    providers: await listLinkedProviders(req.auth!.userId),
  }));

  app.get("/:provider/start", limit(30, "1 minute"), async (req, reply) =>
    begin(req, reply, resolveProvider(req), { mode: "login" }),
  );

  // Привязка к уже вошедшему пользователю (так Telegram-аккаунт попадает к тому же профилю)
  app.get("/:provider/link", limit(30, "1 minute"), async (req, reply) => {
    const provider = resolveProvider(req);
    const token = req.cookies[ACCESS_COOKIE];
    const claims = token ? await verifyAccessToken(token) : null;
    if (!claims) return toWeb(reply, "/login", { error: "UNAUTHENTICATED" });
    return begin(req, reply, provider, { mode: "link", userId: claims.userId });
  });

  app.get("/:provider/callback", limit(30, "1 minute"), async (req, reply) => {
    const provider = resolveProvider(req);
    const flow = readFlowCookie(req, provider.id);
    clearFlowCookie(reply, provider.id); // одноразовая: повторный заход по той же ссылке не сработает

    const failurePath = flow?.intent.mode === "link" ? "/account" : "/login";
    try {
      if (!flow) throw new AppError(400, "OAUTH_STATE");
      const query = callbackQuery.parse(req.query);
      if (query.error) throw new AppError(400, "OAUTH_DENIED");
      if (!query.code || !query.state || !safeEqual(query.state, flow.state)) {
        throw new AppError(400, "OAUTH_STATE");
      }

      const idToken = await exchangeCode(provider, {
        redirectUri: redirectUriFor(provider),
        code: query.code,
        codeVerifier: flow.codeVerifier,
      });
      const claims = await verifyIdToken(provider, idToken, { nonce: flow.nonce });
      const profile = provider.toProfile(claims);

      if (flow.intent.mode === "link") {
        await linkProfile(flow.intent.userId, provider.authProvider, profile);
        return toWeb(reply, "/account", { linked: provider.id });
      }

      const user = await loginWithProfile(provider.authProvider, profile);
      const tokens = await createSession(user, { ip: req.ip, userAgent: req.headers["user-agent"] });
      setAuthCookies(reply, tokens);
      return toWeb(reply, flow.returnTo ?? "/account");
    } catch (err) {
      if (err instanceof AppError) return toWeb(reply, failurePath, { error: err.code });
      if (err instanceof z.ZodError) return toWeb(reply, failurePath, { error: "OAUTH_STATE" });
      req.log.error({ err, provider: provider.id }, "oauth callback failed");
      return toWeb(reply, failurePath, { error: "OAUTH_FAILED" });
    }
  });
};
