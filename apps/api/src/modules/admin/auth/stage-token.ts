import { jwtVerify, SignJWT } from "jose";
import { AppError } from "../../../lib/errors";
import { stageTokenKey } from "../admin.keys";

// Короткоживущий токен между вводом пароля и вводом кода 2FA. Сессии не даёт.
export type Stage = "verify" | "enroll";

const AUDIENCE = "vpn-shop:admin-stage";
const ISSUER = "vpn-shop";
const TTL_SECONDS = 5 * 60;

export const signStageToken = (userId: string, stage: Stage): Promise<string> =>
  new SignJWT({ stage })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(stageTokenKey());

export async function verifyStageToken(token: string, expected: Stage): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, stageTokenKey(), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
    if (payload.stage !== expected || !payload.sub) throw new Error("wrong stage");
    return payload.sub;
  } catch {
    throw new AppError(401, "INVALID_STAGE"); // истёк или не тот этап: начните вход заново
  }
}
