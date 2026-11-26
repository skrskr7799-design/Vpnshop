import { z } from "zod";

// Один и тот же контракт валидации для фронта и бэка.
export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

const newPassword = z.string().min(10).max(128);
const token = z.string().min(20).max(200);

export const registerSchema = z.object({ email: emailField, password: newPassword });
export const loginSchema = z.object({ email: emailField, password: z.string().min(1).max(128) });
export const verifyEmailSchema = z.object({ token });
export const forgotPasswordSchema = z.object({ email: emailField });
export const resetPasswordSchema = z.object({ token, password: newPassword });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

// Публичное представление пользователя (то, что отдаёт API)
export type PublicUser = { id: string; email: string | null; role: "USER" | "OWNER" | "ADMIN" | "SUPPORT" };
