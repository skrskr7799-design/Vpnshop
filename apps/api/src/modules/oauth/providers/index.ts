import { env } from "../../../config/env";
import type { OAuthProvider, ProviderMap } from "../oauth.types";
import { createGoogleProvider } from "./google";
import { createTelegramProvider } from "./telegram";

// Включены только те провайдеры, для которых заданы ключи.
export function loadProviders(): ProviderMap {
  const providers = new Map<OAuthProvider["id"], OAuthProvider>();
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.set("google", createGoogleProvider({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }));
  }
  if (env.TELEGRAM_OIDC_VERIFIED === "true" && env.TELEGRAM_CLIENT_ID && env.TELEGRAM_CLIENT_SECRET) {
    providers.set(
      "telegram",
      createTelegramProvider({ clientId: env.TELEGRAM_CLIENT_ID, clientSecret: env.TELEGRAM_CLIENT_SECRET }),
    );
  }
  return providers;
}
