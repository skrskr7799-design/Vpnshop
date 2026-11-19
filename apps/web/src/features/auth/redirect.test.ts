import { describe, expect, it } from "vitest";
import { getRedirectTarget } from "./redirect";

describe("getRedirectTarget", () => {
  it("возвращает сохранённый внутренний путь с query и hash", () => {
    expect(getRedirectTarget({ from: { pathname: "/orders", search: "?a=1", hash: "#x" } })).toBe("/orders?a=1#x");
  });

  it("по умолчанию ведёт в аккаунт", () => {
    expect(getRedirectTarget(null)).toBe("/account");
    expect(getRedirectTarget({})).toBe("/account");
  });

  it("не пускает на внешние и protocol-relative адреса", () => {
    expect(getRedirectTarget({ from: { pathname: "//evil.example" } })).toBe("/account");
    expect(getRedirectTarget({ from: { pathname: "https://evil.example" } })).toBe("/account");
  });

  it("не возвращает на страницы входа", () => {
    expect(getRedirectTarget({ from: { pathname: "/login" } })).toBe("/account");
  });
});
