import { useQuery } from "@tanstack/react-query";
import type { OAuthProviderId } from "@vpn/shared";
import { request } from "../../api/client";

export const OAUTH_LABELS: Record<OAuthProviderId, string> = { google: "Google", telegram: "Telegram" };

// Вход идёт полной навигацией (редирект на провайдера), а не fetch
export const oauthStartUrl = (provider: OAuthProviderId, returnTo?: string): string =>
  `/api/auth/oauth/${provider}/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`;

type Capabilities = { providers: Record<OAuthProviderId, boolean>; emailAvailable?: boolean };
const queryFn = () => request<Capabilities>("/auth/oauth/providers");
export function useAuthCapabilities() {
  return useQuery({ queryKey: ["auth", "oauth-providers"], queryFn, staleTime: 30_000, retry: false });
}

export function useOAuthProviders() {
  return useQuery({ queryKey: ["auth", "oauth-providers"], queryFn, staleTime: 30_000,
    select: (result: Capabilities) => result.providers, retry: false });
}
