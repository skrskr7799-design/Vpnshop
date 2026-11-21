import { describe, expect, it } from "vitest";
import { currentCode, generateTotpSecret, totpUri, verifyTotp } from "./totp";

// Тестовый секрет из RFC 6238 (ASCII "12345678901234567890" в base32)
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("совпадает с тестовым вектором RFC 6238 (время 59 с, 6 цифр)", () => {
    expect(currentCode(RFC_SECRET, 59_000)).toBe("287082");
    expect(verifyTotp(RFC_SECRET, "287082", 59_000)).toBe(1);
  });

  it("принимает код соседнего шага (расхождение часов), но не дальше", () => {
    const code = currentCode(RFC_SECRET, 59_000);
    expect(verifyTotp(RFC_SECRET, code, 59_000 + 30_000)).toBe(1); // шаг назад
    expect(verifyTotp(RFC_SECRET, code, 59_000 + 90_000)).toBeNull(); // слишком старый
  });

  it("отклоняет неверные и некорректные коды", () => {
    expect(verifyTotp(RFC_SECRET, "000000", 59_000)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", 59_000)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", 59_000)).toBeNull();
  });

  it("генерирует уникальные секреты и корректный otpauth-URI", () => {
    const a = generateTotpSecret();
    expect(a).not.toBe(generateTotpSecret());
    const uri = totpUri(a, "root@example.com");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(`secret=${a}`);
    expect(uri).toContain("digits=6");
  });
});
