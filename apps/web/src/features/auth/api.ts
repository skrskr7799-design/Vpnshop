import type {
  ForgotPasswordInput,
  LoginInput,
  PublicUser,
  RegisterInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from "@vpn/shared";
import { ApiError } from "../../api/ApiError";
import { request } from "../../api/client";

// Эндпоинты авторизации сами выдают и проверяют сессию, поэтому skipRefresh.
const auth = { method: "POST", skipRefresh: true } as const;

export const authApi = {
  register: (body: RegisterInput) => request<{ ok: true }>("/auth/register", { ...auth, body }),
  verifyEmail: (body: VerifyEmailInput) => request<void>("/auth/verify-email", { ...auth, body }),
  login: (body: LoginInput) => request<{ user: PublicUser }>("/auth/login", { ...auth, body }),
  logout: () => request<void>("/auth/logout", auth),
  forgotPassword: (body: ForgotPasswordInput) => request<{ ok: true }>("/auth/forgot-password", { ...auth, body }),
  resetPassword: (body: ResetPasswordInput) => request<void>("/auth/reset-password", { ...auth, body }),
};

// null означает «не авторизован» (штатное состояние, а не ошибка).
// Просроченный access-токен клиент тихо обновляет внутри request().
export async function fetchMe(): Promise<PublicUser | null> {
  try {
    const { user } = await request<{ user: PublicUser }>("/auth/me");
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}
