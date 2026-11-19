import { describe, expect, it } from "vitest";
import { sanitizeReturnTo } from "./return-to";

describe("sanitizeReturnTo", () => {
  it("пропускает внутренние пути с query и hash", () => {
    expect(sanitizeReturnTo("/orders?a=1#x")).toBe("/orders?a=1#x");
  });

  it.each(["//evil.example", "https://evil.example", "/\\evil.example", "evil", "/a\nb", "/login", "/login?x=1"])(
    "отклоняет %j",
    (value) => {
      expect(sanitizeReturnTo(value)).toBeUndefined();
    },
  );

  it("отклоняет не строки и слишком длинные значения", () => {
    expect(sanitizeReturnTo(undefined)).toBeUndefined();
    expect(sanitizeReturnTo(42)).toBeUndefined();
    expect(sanitizeReturnTo("/" + "a".repeat(400))).toBeUndefined();
  });
});
