import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Из одного мастер-ключа выводим отдельные ключи под разные задачи (шифрование, подпись):
// один и тот же ключ для разных целей использовать нельзя.
export function deriveKey(masterKeyBase64: string, label: string): Buffer {
  const master = Buffer.from(masterKeyBase64, "base64");
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `vpn-shop:${label}`, 32));
}

// AES-256-GCM: формат iv(12) | tag(16) | шифртекст, всё в base64url
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function decrypt(payload: string, key: Buffer): string {
  const raw = Buffer.from(payload, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
