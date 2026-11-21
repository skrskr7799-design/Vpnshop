import type { UserRole } from "@prisma/client";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../../config/env";
import { ACCESS_TTL_SECONDS } from "./auth.constants";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = "vpn-shop";
// Админский API потом получит свой audience и свой секрет, токены не пересекутся.
const AUDIENCE = "vpn-shop:user";

export type AuthClaims = { userId: string; role: UserRole };

export function signAccessToken(claims: AuthClaims): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AuthClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const role = payload.role;
    if (!payload.sub || (role !== "USER" && role !== "ADMIN" && role !== "SUPPORT")) return null;
    return { userId: payload.sub, role };
  } catch {
    return null;
  }
}
