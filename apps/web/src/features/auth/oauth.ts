import { useQuery } from "@tanstack/react-query";
import type { AuthProvider, OAuthProviderId } from "@vpn/shared";
import { request } from "../../api/client";
import { fetchMe } from "./api";

export const OAUTH_LABELS: Record<OAuthProviderId, string> = { google: "Google", telegram: "Telegram" };

// Вход идёт полной навигацией (редирект на провайдера), а не fetch
export const oauthStartUrl = (provider: OAuthProviderId, returnTo?: string): string =>
  `/api/auth/oauth/${provider}/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;

// Какие провайдеры включены на сервере: кнопки показываем только для них
export function useOAuthProviders() {
  return useQuery({
    queryKey: ["auth", "oauth-providers"],
    queryFn: async () =>
      (await request<{ providers: Record<OAuthProviderId, boolean> }>("/auth/oauth/providers")).providers,
    staleTime: Infinity,
    retry: false,
  });
}

// Какие способы входа уже подключены у текущего пользователя
export function useLinkedProviders() {
  return useQuery({
    queryKey: ["auth", "identities"],
    queryFn: async () => (await request<{ providers: AuthProvider[] }>("/auth/oauth/identities")).providers,
  });
}

// Переход по ссылке не умеет обновлять сессию, поэтому сначала делаем запрос:
// он при необходимости тихо обновит access-токен.
export async function connectProvider(provider: OAuthProviderId): Promise<void> {
  const me = await fetchMe();
  window.location.assign(me ? `/api/auth/oauth/${provider}/link` : "/login");
}
