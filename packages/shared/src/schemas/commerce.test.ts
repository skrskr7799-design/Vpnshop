import { expect, it } from "vitest";
import { catalogQuerySchema, checkoutBodySchema, checkoutKeySchema } from "./commerce";

const version = "a10d26d6-ea73-4f9b-bbdb-819d74ecf596";
it("canonicalizes UUID case and rejects caller-supplied terms", () => {
  expect(checkoutBodySchema.parse({ offerVersionId: version.toUpperCase() })).toEqual({ offerVersionId: version });
  for (const extra of [{ userId: version }, { currency: "RUB" }, { amount: 10 }, { deviceLimit: 50 }, { expiresAt: "2030-01-01" }]) {
    expect(checkoutBodySchema.safeParse({ offerVersionId: version, ...extra }).success).toBe(false);
  }
});
it("validates currencies and rejects ambiguous idempotency headers", () => {
  expect(catalogQuerySchema.safeParse({ currency: "EUR" }).success).toBe(false);
  expect(catalogQuerySchema.parse({ currency: "RUB" })).toEqual({ currency: "RUB" });
  expect(checkoutKeySchema.parse(version)).toBe(version);
  for (const key of ["too-short", "a".repeat(129), "valid-looking-key, second-key", "некорректный ключ"]) {
    expect(checkoutKeySchema.safeParse(key).success).toBe(false);
  }
});
