import { env } from "../../config/env";
import { deriveKey } from "../../lib/secret-box";

// Ключи выводятся лениво: пока админка выключена, ADMIN_ENCRYPTION_KEY не нужен.
const cache = new Map<string, Buffer>();

function key(label: string): Buffer {
  let value = cache.get(label);
  if (!value) {
    if (!env.ADMIN_ENCRYPTION_KEY) throw new Error("ADMIN_ENCRYPTION_KEY is not configured");
    value = deriveKey(env.ADMIN_ENCRYPTION_KEY, label);
    cache.set(label, value);
  }
  return value;
}

export const totpEncryptionKey = (): Buffer => key("admin-totp-encryption");
export const stageTokenKey = (): Buffer => key("admin-stage-token");
