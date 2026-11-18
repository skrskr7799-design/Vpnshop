import { z } from "zod";

// Один и тот же контракт валидации для фронта и бэка.
const email = z.email().max(254).transform((v) => v.trim().toLowerCase());
const password = z.string().min(10).max(128);

export const registerSchema = z.object({ email, password });
export const loginSchema = z.object({ email, password: z.string().min(1).max(128) });

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
