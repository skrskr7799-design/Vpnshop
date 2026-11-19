import { z } from "zod";

// Русские тексты ошибок валидации для форм (контракт схем остаётся общим с бэкендом).
export function configureZodMessages(): void {
  z.config({
    customError: (issue) => {
      switch (issue.code) {
        case "invalid_type":
          return "Заполните поле";
        case "invalid_format":
          return issue.format === "email" ? "Введите корректный email" : "Некорректный формат";
        case "too_small":
          if (issue.origin !== "string") return undefined;
          return Number(issue.minimum) <= 1 ? "Заполните поле" : `Минимум ${issue.minimum} символов`;
        case "too_big":
          return issue.origin === "string" ? `Максимум ${issue.maximum} символов` : undefined;
        default:
          return undefined;
      }
    },
  });
}
