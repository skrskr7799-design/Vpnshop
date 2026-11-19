import { describe, expect, it } from "vitest";
import { generateToken, sha256 } from "./crypto";

describe("crypto", () => {
  it("генерирует уникальные токены достаточной длины", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it("sha256 детерминирован и отличается для разных входов", () => {
    expect(sha256("x")).toBe(sha256("x"));
    expect(sha256("x")).not.toBe(sha256("y"));
    expect(sha256("x")).toHaveLength(64);
  });
});
