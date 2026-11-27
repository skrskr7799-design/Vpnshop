import { describe, expect, it } from "vitest";
import { z } from "zod";
import { paymentRestriction, productSettings } from "./product";

const schema = z.object(productSettings);
describe("product settings", () => {
  it("preserves MZT and starts with optional integrations absent", () => {
    const settings = schema.parse({});
    expect(settings).toMatchObject({ BRAND_NAME: "MZT", REGISTRATION_ENABLED: true, SUPPORT_ENABLED: true, MAINTENANCE_MODE: false });
    expect(paymentRestriction({ ...settings, NODE_ENV: "production" }, { provider: false, panel: false })).toBe("PAYMENTS_DISABLED");
  });

  it("validates operators' flags and disallows credentials and unsafe URL schemes", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,test", "https://user:pass@example.invalid/", "http://example.invalid"]) {
      expect(schema.safeParse({ LEGAL_TERMS_URL: value }).success).toBe(false);
    }
    expect(schema.safeParse({ REGISTRATION_ENABLED: "1" }).success).toBe(false);
    expect(schema.safeParse({ BRAND_NAME: "Название\u0000" }).success).toBe(false);
    expect(schema.parse({ BRAND_NAME: '«Магазин» "пример"', LEGAL_TERMS_URL: "https://example.invalid/terms?a=1&b=2" }).BRAND_NAME)
      .toBe('«Магазин» "пример"');
  });
});
