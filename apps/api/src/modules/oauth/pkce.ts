import { createHash } from "node:crypto";
import { generateToken } from "../../lib/crypto";

// PKCE (RFC 7636): verifier остаётся у нас, провайдеру уходит только его хэш.
export const generateCodeVerifier = (): string => generateToken(32);

export const codeChallengeFromVerifier = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");
