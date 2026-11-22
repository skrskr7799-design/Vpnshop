import type { AuthProvider, OAuthFlow, Prisma } from "@prisma/client";
import { AUTH_PROVIDERS, checkoutKeySchema, type OAuthProviderId } from "@vpn/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../config/env";
import { generateToken, sha256 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { prisma } from "../../lib/prisma";
import { authenticate } from "../auth/authenticate";
import { setAuthCookies } from "../auth/cookies";
import { verifyAgainstDummy, verifyPassword } from "../auth/password";
import { createSession, lockIdentityOwner, requireLiveFamily } from "../auth/session.service";
import { clearFlowCookie, FLOW_TTL_MS, readFlowCookie, setFlowCookie } from "./flow-cookie";
import { buildAuthorizationUrl, exchangeCode, verifyIdToken } from "./oidc";
import { consumeProof, linkProfile, loginWithProfile } from "./oauth.service";
import type { OAuthProvider, ProviderMap } from "./oauth.types";
import { codeChallengeFromVerifier, generateCodeVerifier } from "./pkce";
import { sanitizeReturnTo } from "./return-to";

const limit = (max: number, timeWindow: string) => ({ config: { rateLimit: { max, timeWindow } } });
const callbackQuery = z.object({
  code: z.string().max(2048).optional(), state: z.string().max(128).optional(), error: z.string().max(200).optional(),
});
const proofCommand = z.strictObject({ confirmationId: z.uuid() });
const linkCommand = proofCommand.extend({ returnTo: z.string().max(512).optional() });
const reauthCommand = z.strictObject({
  target: z.enum(AUTH_PROVIDERS), purpose: z.enum(["LINK", "UNLINK"]), method: z.enum(AUTH_PROVIDERS), password: z.string().max(128).optional(),
}).refine(value => (value.method === "EMAIL") === !!value.password);

const redirectUriFor = (provider: OAuthProvider) => new URL(`/api/auth/oauth/${provider.id}/callback`, env.WEB_ORIGIN).toString();
const toWeb = (reply: FastifyReply, path: string, query: Record<string, string> = {}) => {
  const url = new URL(path, env.WEB_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return reply.redirect(url.toString());
};
const newBrowser = (req: FastifyRequest, provider: OAuthProvider) => readFlowCookie(req, provider.id) ?? generateToken();
const proofExpiry = () => new Date(Date.now() + 5 * 60_000);

function begin(db: Prisma.TransactionClient, provider: OAuthProvider, browser: string,
  extras: Pick<Prisma.OAuthFlowUncheckedCreateInput, "mode" | "returnTo" | "familyId" | "target" | "purpose" | "requestKeyHash" | "fingerprint" | "proofId">,
) {
  return db.oAuthFlow.create({ data: {
    ...extras, state: generateToken(), verifier: generateCodeVerifier(), browserHash: sha256(browser), provider: provider.id,
    nonce: provider.useNonce ? generateToken() : null, expiresAt: new Date(Date.now() + FLOW_TTL_MS),
  } });
}
function authorize(provider: OAuthProvider, flow: OAuthFlow) {
  const url = new URL(buildAuthorizationUrl(provider, {
    redirectUri: redirectUriFor(provider), state: flow.state,
    codeChallenge: codeChallengeFromVerifier(flow.verifier), nonce: flow.nonce ?? undefined,
  }));
  if (flow.mode === "reauth") url.searchParams.set("max_age", "0");
  return { authorizeUrl: url.href, expiresAt: flow.expiresAt };
}

const validIdentity = (identity: { provider: AuthProvider; verifiedAt: Date | null; passwordHash: string | null }, providers: ProviderMap) =>
  Boolean(identity.verifiedAt) && (identity.provider === "EMAIL" ? !!identity.passwordHash :
    providers.has(identity.provider.toLowerCase() as OAuthProviderId));

export const oauthRoutes: FastifyPluginAsync<{ providers: ProviderMap }> = async (app, { providers }) => {
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
  });
  const resolveProvider = (id: string) => {
    const provider = providers.get(id as OAuthProviderId);
    if (!provider) throw new AppError(404, "PROVIDER_DISABLED");
    return provider;
  };
  const providerParam = (req: FastifyRequest) => (req.params as { provider: string }).provider;

  app.get("/providers", async () => ({
    providers: { google: providers.has("google"), telegram: providers.has("telegram") },
  }));

  app.get("/identities", { preHandler: authenticate }, async req => {
    const rows = await prisma.authIdentity.findMany({ where: { userId: req.auth!.userId } });
    const usable = rows.filter(row => validIdentity(row, providers)).length;
    return { providers: rows.map(row => row.provider), identities: rows.map(row => ({
      provider: row.provider, verified: !!row.verifiedAt, usable: validIdentity(row, providers),
      canUnlink: usable - Number(validIdentity(row, providers)) > 0, addedAt: row.createdAt,
    })) };
  });

  app.get("/:provider/start", limit(30, "1 minute"), async (req, reply) => {
    const provider = resolveProvider(providerParam(req));
    const browser = newBrowser(req, provider);
    const flow = await begin(prisma, provider, browser, {
      mode: "login", returnTo: sanitizeReturnTo((req.query as { returnTo?: unknown }).returnTo),
    });
    setFlowCookie(reply, provider.id, browser);
    return reply.redirect(authorize(provider, flow).authorizeUrl);
  });

  app.get("/reauth", { preHandler: authenticate }, async req => ({
    confirmations: await prisma.identityProof.findMany({
      where: { familyId: req.auth!.sid, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: "desc" }, take: 10, select: { id: true, target: true, purpose: true, expiresAt: true },
    }),
  }));

  app.post("/reauth", { ...limit(8, "1 minute"), preHandler: authenticate }, async (req, reply) => {
    const input = reauthCommand.parse(req.body);
    const claims = req.auth!;
    const before = await prisma.authIdentity.findUnique({
      where: { userId_provider: { userId: claims.userId, provider: input.method } },
    });
    if (input.method === "EMAIL") {
      const matches = before?.passwordHash ? await verifyPassword(before.passwordHash, input.password!) :
        (await verifyAgainstDummy(input.password!), false);
      if (!matches || !before?.verifiedAt) throw new AppError(403, "REAUTH_FAILED");
      return prisma.$transaction(async db => {
        await lockIdentityOwner(db, claims.userId);
        await requireLiveFamily(claims, db);
        const identity = await db.authIdentity.findUnique({ where: { id: before.id } });
        if (!identity || identity.passwordHash !== before.passwordHash) throw new AppError(403, "REAUTH_FAILED");
        const proof = await db.identityProof.create({
          data: { familyId: claims.sid, target: input.target, purpose: input.purpose, expiresAt: proofExpiry() },
        });
        return { confirmationId: proof.id, expiresAt: proof.expiresAt };
      });
    }
    const provider = resolveProvider(input.method.toLowerCase());
    if (!before?.verifiedAt) throw new AppError(403, "REAUTH_FAILED");
    const browser = newBrowser(req, provider);
    const flow = await prisma.$transaction(async db => {
      await lockIdentityOwner(db, claims.userId);
      await requireLiveFamily(claims, db);
      return begin(db, provider, browser, { mode: "reauth", familyId: claims.sid, target: input.target, purpose: input.purpose });
    });
    setFlowCookie(reply, provider.id, browser);
    return reply.code(202).send(authorize(provider, flow));
  });

  app.post("/:provider/link", { ...limit(10, "1 minute"), preHandler: authenticate }, async (req, reply) => {
    const provider = resolveProvider(providerParam(req));
    const input = linkCommand.parse(req.body);
    const claims = req.auth!;
    const key = sha256(checkoutKeySchema.parse(req.headers["idempotency-key"]));
    const returnTo = sanitizeReturnTo(input.returnTo);
    const fingerprint = sha256(JSON.stringify([input.confirmationId, returnTo]));
    const browser = newBrowser(req, provider);
    const flow = await prisma.$transaction(async db => {
      await lockIdentityOwner(db, claims.userId);
      await requireLiveFamily(claims, db);
      const existing = await db.oAuthFlow.findUnique({ where: { familyId_provider_requestKeyHash: {
        familyId: claims.sid, provider: provider.id, requestKeyHash: key,
      } } });
      if (existing && existing.fingerprint !== fingerprint) throw new AppError(409, "IDEMPOTENCY_CONFLICT");
      if (existing) {
        if (existing.browserHash !== sha256(browser) || existing.consumedAt || existing.expiresAt <= new Date()) {
          throw new AppError(409, "OAUTH_STATE");
        }
        return existing;
      }
      if (!(await consumeProof(db, claims, input.confirmationId, provider.authProvider, "LINK")).count) {
        throw new AppError(403, "REAUTH_REQUIRED");
      }
      return begin(db, provider, browser, { mode: "link", familyId: claims.sid, returnTo, proofId: input.confirmationId,
        requestKeyHash: key, fingerprint });
    });
    setFlowCookie(reply, provider.id, browser);
    return authorize(provider, flow);
  });

  app.delete("/identities/:provider", { ...limit(10, "1 minute"), preHandler: authenticate }, async (req, reply) => {
    const provider = z.enum(AUTH_PROVIDERS).parse(providerParam(req));
    const { confirmationId } = proofCommand.parse(req.body);
    const claims = req.auth!;
    await prisma.$transaction(async db => {
      await lockIdentityOwner(db, claims.userId);
      await requireLiveFamily(claims, db);
      const rows = await db.authIdentity.findMany({ where: { userId: claims.userId } });
      const target = rows.find(row => row.provider === provider);
      if (!target) throw new AppError(404, "NOT_FOUND");
      if (!rows.some(row => row.id !== target.id && validIdentity(row, providers))) throw new AppError(409, "LAST_LOGIN_METHOD");
      if (!(await consumeProof(db, claims, confirmationId, provider, "UNLINK")).count) throw new AppError(403, "REAUTH_REQUIRED");
      await db.authIdentity.delete({ where: { id: target.id } });
      if (provider === "EMAIL") await db.user.update({ where: { id: claims.userId }, data: { emailLoginDisabled: true } });
      await db.identityProof.deleteMany({ where: { family: { userId: claims.userId } } });
      await db.oAuthFlow.deleteMany({ where: { family: { userId: claims.userId } } });
    });
    return reply.code(204).send();
  });

  app.get("/:provider/callback", limit(30, "1 minute"), async (req, reply) => {
    const provider = resolveProvider(providerParam(req));
    const browser = readFlowCookie(req, provider.id);
    clearFlowCookie(reply, provider.id);
    let failurePath = "/login";
    try {
      const { code, state, error } = callbackQuery.parse(req.query);
      if (!browser || !state || (!code && !error)) throw new AppError(400, "OAUTH_STATE");
      const now = new Date();
      const flow = await prisma.oAuthFlow.findFirst({ where: {
        state, provider: provider.id, browserHash: sha256(browser), expiresAt: { gt: now }, consumedAt: null,
      } });
      if (!flow || !(await prisma.oAuthFlow.updateMany({
        where: { state, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now, verifier: "", nonce: null, browserHash: "" },
      })).count) throw new AppError(400, "OAUTH_STATE");
      if (flow.familyId) {
        failurePath = "/account/security";
        await authenticate(req);
        if (req.auth!.sid !== flow.familyId) throw new AppError(403, "OAUTH_STATE");
      }
      if (error || !code) throw new AppError(400, "OAUTH_DENIED");
      const idToken = await exchangeCode(provider, { redirectUri: redirectUriFor(provider), code, codeVerifier: flow.verifier });
      const claims = await verifyIdToken(provider, idToken, { nonce: flow.nonce ?? undefined });
      const profile = provider.toProfile(claims);
      if (flow.mode === "link") {
        await linkProfile(req.auth!, provider.authProvider, profile);
        return toWeb(reply, flow.returnTo ?? "/account/security", { linked: provider.id });
      }
      if (flow.mode === "reauth" && flow.target && flow.purpose) {
        const authTime = typeof claims.auth_time === "number" ? claims.auth_time * 1000 : 0;
        if (!Number.isSafeInteger(authTime) || authTime < +flow.expiresAt - FLOW_TTL_MS - 30_000 ||
            authTime > Date.now() + 30_000) throw new AppError(403, "REAUTH_FAILED");
        const session = req.auth!;
        const target = flow.target;
        const purpose = flow.purpose;
        await prisma.$transaction(async db => {
          await lockIdentityOwner(db, session.userId);
          await requireLiveFamily(session, db);
          const identity = await db.authIdentity.findUnique({ where: { userId_provider: { userId: session.userId, provider: provider.authProvider } } });
          if (!identity?.verifiedAt || identity.providerId !== profile.providerId) throw new AppError(403, "REAUTH_FAILED");
          await db.identityProof.create({ data: { familyId: session.sid, target, purpose, expiresAt: proofExpiry() } });
        });
        return toWeb(reply, "/account/security", { reauth: "ok" });
      }
      if (flow.mode !== "login") throw new AppError(400, "OAUTH_STATE");

      const user = await loginWithProfile(provider.authProvider, profile);
      const tokens = await prisma.$transaction(async db => {
        await lockIdentityOwner(db, user.id);
        const identity = await db.authIdentity.findUnique({ where: { provider_providerId: {
          provider: provider.authProvider, providerId: profile.providerId,
        } } });
        if (identity?.userId !== user.id) throw new AppError(403, "OAUTH_STATE");
        return createSession(user, { ip: req.ip, userAgent: req.headers["user-agent"] }, db);
      });
      setAuthCookies(reply, tokens);
      return toWeb(reply, flow.returnTo ?? "/account");
    } catch (err) {
      if (err instanceof AppError) return toWeb(reply, failurePath, { error: err.code });
      if (err instanceof z.ZodError) return toWeb(reply, failurePath, { error: "OAUTH_STATE" });
      req.log.warn({ provider: provider.id }, "OAuth callback failed");
      return toWeb(reply, failurePath, { error: "OAUTH_FAILED" });
    }
  });
};
