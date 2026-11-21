import { describe, expect, it } from "vitest";
import { decrypt, deriveKey, encrypt } from "./secret-box";

const master = Buffer.alloc(32, 9).toString("base64");

describe("secret-box", () => {
  it("шифрует и расшифровывает", () => {
    const key = deriveKey(master, "test");
    expect(decrypt(encrypt("JBSWY3DPEHPK3PXP", key), key)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("каждый раз разный шифртекст (случайный iv)", () => {
    const key = deriveKey(master, "test");
    expect(encrypt("same", key)).not.toBe(encrypt("same", key));
  });

  it("ключи для разных целей различаются", () => {
    expect(deriveKey(master, "a").equals(deriveKey(master, "b"))).toBe(false);
    expect(deriveKey(master, "a").equals(deriveKey(master, "a"))).toBe(true);
  });

  it("чужой ключ и подделка шифртекста отклоняются", () => {
    const key = deriveKey(master, "a");
    const payload = encrypt("secret", key);
    expect(() => decrypt(payload, deriveKey(master, "b"))).toThrow();
    const tampered = payload.slice(0, -2) + (payload.endsWith("AA") ? "BB" : "AA");
    expect(() => decrypt(tampered, key)).toThrow();
  });
});
