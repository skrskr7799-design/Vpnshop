import { z } from "zod";
import { CURRENCIES } from "../constants";
import { emailField } from "./auth";

// ───── вход в админку ─────
export const adminLoginSchema = z.object({ email: emailField, password: z.string().min(1).max(128) });

const stageToken = z.string().min(20).max(2000);
const totpCode = z.string().trim().regex(/^\d{6}$/, "Введите 6 цифр");

export const adminEnrollStartSchema = z.object({ stageToken });
export const adminEnrollConfirmSchema = z.object({ stageToken, code: totpCode });
export const adminVerifySchema = z
  .object({
    stageToken,
    code: totpCode.optional(),
    recoveryCode: z.string().trim().min(8).max(24).optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), { message: "Нужен либо код, либо резервный код" });

// ───── общее ─────
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ───── тарифы ─────
export const planCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}$/, "Латиница, цифры и дефис, 2-31 символ");

// Поля тарифа без значений по умолчанию: от них строится и создание, и частичное обновление.
// Значения по умолчанию в схеме обновления недопустимы: PATCH {name} иначе молча включил бы
// отключённый тариф и сбросил порядок сортировки.
const planFields = {
  name: z.string().trim().min(1).max(80),
  deviceLimit: z.number().int().min(1).max(100),
  sortOrder: z.number().int().min(0).max(1000),
  isActive: z.boolean(),
};

export const createPlanSchema = z.object({
  code: planCodeSchema,
  ...planFields,
  sortOrder: planFields.sortOrder.default(0),
  isActive: planFields.isActive.default(true),
});

export const updatePlanSchema = z
  .object(planFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Нет изменений" });

// Сумма в минимальных единицах: копейки, центы, Stars
export const upsertPriceSchema = z.object({
  durationMonths: z.number().int().min(1).max(36),
  currency: z.enum(CURRENCIES),
  amount: z.number().int().min(1).max(100_000_000),
  isActive: z.boolean().default(true),
});

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
export type UpsertPriceInput = z.infer<typeof upsertPriceSchema>;
