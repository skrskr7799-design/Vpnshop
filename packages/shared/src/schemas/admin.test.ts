import { describe, expect, it } from "vitest";
import { createPlanSchema, updatePlanSchema } from "./admin";

describe("схемы тарифов", () => {
  it("создание подставляет значения по умолчанию", () => {
    expect(createPlanSchema.parse({ code: "starter", name: "S", deviceLimit: 5 })).toMatchObject({ sortOrder: 0, isActive: true });
  });

  it("обновление НЕ подставляет значения по умолчанию (иначе PATCH {name} включит отключённый тариф)", () => {
    expect(updatePlanSchema.parse({ name: "Новый" })).toEqual({ name: "Новый" });
    expect(updatePlanSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it("пустое обновление и смена кода отклоняются", () => {
    expect(updatePlanSchema.safeParse({}).success).toBe(false);
    expect(updatePlanSchema.safeParse({ code: "hack" }).success).toBe(false); // код после отбрасывания чужих полей пуст
  });
});
