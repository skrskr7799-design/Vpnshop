import { describe, expect, it } from "vitest";
import { loginSchema, registerSchema, resetPasswordSchema } from "./auth";

describe("auth schemas", () => {
  it("нормализует email: trim + lowercase", () => {
    const r = registerSchema.parse({ email: "  User@Example.COM ", password: "correct-horse-battery" });
    expect(r.email).toBe("user@example.com");
  });

  it("отклоняет короткий пароль при регистрации", () => {
    expect(registerSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
  });

  it("отклоняет невалидный email", () => {
    expect(loginSchema.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });

  it("при сбросе пароля тоже требует минимальную длину", () => {
    expect(resetPasswordSchema.safeParse({ token: "t".repeat(30), password: "short" }).success).toBe(false);
  });
});
