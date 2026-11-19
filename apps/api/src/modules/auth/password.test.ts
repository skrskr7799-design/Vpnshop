import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password";

describe("password", () => {
  it("хэширует в argon2id и проверяет пароль", async () => {
    const hashed = await hashPassword("correct-horse-battery");
    expect(hashed.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hashed, "correct-horse-battery")).toBe(true);
    expect(await verifyPassword(hashed, "wrong-password-here")).toBe(false);
  });

  it("не бросает на битом хэше", async () => {
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });

  it("dummy-проверка не падает", async () => {
    await expect(verifyAgainstDummy("anything")).resolves.toBeUndefined();
  });
});
