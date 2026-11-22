import { describe, expect, it } from "vitest";
import { exactHttpsOrigin, isRestrictedPeer } from "./proxy";

describe("deployment network guards", () => {
  it.each(["127.0.0.1", "10.1.2.0/24", "fd20::/64", "::1", "::ffff:192.0.2.0/120"])("accepts bounded peer %s", peer => {
    expect(isRestrictedPeer(peer)).toBe(true);
  });
  it.each(["0.0.0.0/0", "::/0", "::ffff:0.0.0.0/96", "arbitrary", "10.0.0.0/33"])("rejects invalid or unrestricted %s", peer => {
    expect(isRestrictedPeer(peer)).toBe(false);
  });
  it("requires exact HTTPS origins", () => {
    expect(exactHttpsOrigin("https://admin.example.invalid:8443")).toBe(true);
    expect(exactHttpsOrigin("https://admin.example.invalid/session")).toBe(false);
    expect(exactHttpsOrigin("http://admin.example.invalid")).toBe(false);
  });
});
