import { expect, it, vi } from "vitest";
import { makeQr } from "./ConnectionPage";

it("encodes QR locally without emitting the secret in the SVG path or using a network request", () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const first = makeQr("https://links.example.invalid/secret-test-value");
    const second = makeQr("https://links.example.invalid/another-value");
    expect(first.size).toBeGreaterThan(20);
    expect(first.path).not.toContain("secret-test-value");
    expect(first.path).not.toBe(second.path);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
