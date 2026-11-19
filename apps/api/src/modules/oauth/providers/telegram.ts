import { AppError } from "../../../lib/errors";
import type { OAuthProvider } from "../oauth.types";

type Endpoints = Pick<OAuthProvider, "authorizeUrl" | "tokenUrl" | "jwksUrl">;

const DEFAULT_ENDPOINTS: Endpoints = {
  authorizeUrl: "https://oauth.telegram.org/auth",
  tokenUrl: "https://oauth.telegram.org/token",
  jwksUrl: "https://oauth.telegram.org/.well-known/jwks.json",
};

// Client ID здесь это числовой id бота, Client Secret выдаёт @BotFather (Login Widget).
export function createTelegramProvider(
  creds: { clientId: string; clientSecret: string },
  endpoints: Partial<Endpoints> = {},
): OAuthProvider {
  return {
    id: "telegram",
    authProvider: "TELEGRAM",
    ...creds,
    ...DEFAULT_ENDPOINTS,
    ...endpoints,
    issuers: ["https://oauth.telegram.org"],
    // RS256 по умолчанию, ES256 выбирается в BotFather. EdDSA/ES256K не принимаем:
    // они ограничены scope openid, а нам нужен profile.
    algorithms: ["RS256", "ES256"],
    scope: "openid profile",
    tokenAuth: "basic",
    // nonce в ручном (redirect) потоке Telegram не документирован; защищают state + PKCE
    useNonce: false,
    toProfile(claims) {
      // Настоящий Telegram user id лежит в клэйме id (scope profile), по нему же
      // бот видит пользователя, например в платежах Stars. sub это другой идентификатор.
      const id = claims.id;
      if (typeof id !== "number" && typeof id !== "string") {
        throw new AppError(400, "TELEGRAM_PROFILE_MISSING");
      }
      return { providerId: String(id), email: null, emailVerified: false };
    },
  };
}
