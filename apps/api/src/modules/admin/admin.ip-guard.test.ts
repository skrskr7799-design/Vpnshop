import { describe, expect, it } from "vitest";
import { createIpGuard } from "./admin.ip-guard";

describe("createIpGuard", () => {
  it("пустой список пропускает всех", () => {
    expect(createIpGuard([])("203.0.113.9")).toBe(true);
  });

  it("пропускает только свои сети", () => {
    const allowed = createIpGuard(["100.64.0.0/10", "10.0.0.0/8", "fd00::/8"]);
    expect(allowed("100.100.1.1")).toBe(true);
    expect(allowed("10.1.2.3")).toBe(true);
    expect(allowed("fd12::1")).toBe(true);
    expect(allowed("203.0.113.9")).toBe(false);
    expect(allowed("2001:db8::1")).toBe(false);
  });

  it("понимает IPv4-mapped IPv6 и отклоняет мусор", () => {
    const allowed = createIpGuard(["10.0.0.0/8"]);
    expect(allowed("::ffff:10.1.1.1")).toBe(true);
    expect(allowed("not-an-ip")).toBe(false);
  });

  it("падает при старте на неверном CIDR", () => {
    expect(() => createIpGuard(["300.1.1.1/8"])).toThrow();
  });
});
