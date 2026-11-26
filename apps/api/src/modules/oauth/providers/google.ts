import { emailField } from "@vpn/shared";
import { AppError } from "../../../lib/errors";
import type { OAuthProvider } from "../oauth.types";

type Endpoints = Pick<OAuthProvider, "authorizeUrl" | "tokenUrl" | "jwksUrl">;

const DEFAULT_ENDPOINTS: Endpoints = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
};

export function createGoogleProvider(
  creds: { clientId: string; clientSecret: string },
  endpoints: Partial<Endpoints> = {},
): OAuthProvider {
  return {
    id: "google",
    authProvider: "GOOGLE",
    ...creds,
    ...DEFAULT_ENDPOINTS,
    ...endpoints,
    // Google использует оба написания issuer
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    algorithms: ["RS256"],
    scope: "openid email",
    tokenAuth: "post",
    useNonce: true,
    toProfile(claims) {
      if (!claims.sub) throw new AppError(400, "OAUTH_FAILED");
      const email = emailField.safeParse(claims.email);
      const hostedDomain = typeof claims.hd === "string" && claims.hd.length > 0;
      // For third-party addresses Google may only have verified past ownership.
      const authoritative = email.success && (email.data.endsWith("@gmail.com") || hostedDomain);
      return {
        providerId: claims.sub,
        email: email.success ? email.data : null,
        emailVerified: authoritative && claims.email_verified === true,
      };
    },
  };
}
