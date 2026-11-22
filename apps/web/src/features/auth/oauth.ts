import { useQuery } from "@tanstack/react-query";
import type { OAuthProviderId } from "@vpn/shared";
import { request } from "../../api/client";

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
