import { registerSchema, resetPasswordSchema } from "@vpn/shared";
import { z } from "zod";

// Подтверждение пароля существует только на клиенте, на сервер не уходит.
const mismatch = { path: ["confirmPassword"], message: "Пароли не совпадают" };

export const registerFormSchema = registerSchema
  .extend({ confirmPassword: z.string().min(1) })
  .refine((v) => v.password === v.confirmPassword, mismatch);

export const resetFormSchema = z
  .object({ password: resetPasswordSchema.shape.password, confirmPassword: z.string().min(1) })
  .refine((v) => v.password === v.confirmPassword, mismatch);

export type RegisterForm = z.infer<typeof registerFormSchema>;
export type ResetForm = z.infer<typeof resetFormSchema>;
