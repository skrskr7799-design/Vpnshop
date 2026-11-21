import { Secret, TOTP } from "otpauth";

const ISSUER = "VPN Shop Admin";
const PERIOD = 30;

const make = (secretBase32: string, label = "admin") =>
  new TOTP({ issuer: ISSUER, label, algorithm: "SHA1", digits: 6, period: PERIOD, secret: Secret.fromBase32(secretBase32) });

export const generateTotpSecret = (): string => new Secret({ size: 20 }).base32;

export const totpUri = (secretBase32: string, accountLabel: string): string => make(secretBase32, accountLabel).toString();

// Возвращает номер 30-секундного шага, в который попал код, или null.
// Допуск ±1 шаг на расхождение часов. По номеру шага отсекаем повторное использование кода.
export function verifyTotp(secretBase32: string, code: string, nowMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const totp = make(secretBase32);
  const delta = totp.validate({ token: code, timestamp: nowMs, window: 1 });
  if (delta === null) return null;
  return totp.counter({ timestamp: nowMs }) + delta;
}

export const currentCode = (secretBase32: string, nowMs: number = Date.now()): string =>
  make(secretBase32).generate({ timestamp: nowMs });
