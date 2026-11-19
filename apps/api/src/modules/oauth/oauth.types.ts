import type { AuthProvider } from "@prisma/client";
import type { OAuthProviderId } from "@vpn/shared";
import type { JWTPayload } from "jose";

// То, что нам нужно знать о пользователе от внешнего сервиса
export type ProviderProfile = {
  providerId: string; // стабильный id пользователя у провайдера
  email: string | null;
  emailVerified: boolean;
};

// Конфигурация OIDC-провайдера. Весь протокол общий (oidc.ts), провайдеры отличаются только данными.
export type OAuthProvider = {
  id: OAuthProviderId;
  authProvider: AuthProvider;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  issuers: string[];
  algorithms: string[];
  scope: string;
  // как передавать client_id/secret на token endpoint
  tokenAuth: "basic" | "post";
  // поддерживает ли провайдер nonce в id_token
  useNonce: boolean;
  toProfile(claims: JWTPayload): ProviderProfile;
};

export type ProviderMap = ReadonlyMap<OAuthProviderId, OAuthProvider>;
