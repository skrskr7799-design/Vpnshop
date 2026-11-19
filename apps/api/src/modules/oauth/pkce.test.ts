import { describe, expect, it } from "vitest";
import { codeChallengeFromVerifier, generateCodeVerifier } from "./pkce";

describe("pkce", () => {
  it("совпадает с тестовым вектором RFC 7636 (приложение B)", () => {
    expect(codeChallengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifier укладывается в допустимую длину 43..128", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
  });
});
