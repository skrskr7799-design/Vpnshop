import type {
  ForgotPasswordInput,
  LoginInput,
  PublicUser,
  RegisterInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from "@vpn/shared";
import { ApiError } from "../../api/ApiError";
import { bindPrivateSession, request } from "../../api/client";

export type SessionUser = PublicUser & { sessionId: string };
const logoutMarker = "mzt.logout-unconfirmed";
let localLogout = false;
export function logoutHidden() {
  try { return localLogout || sessionStorage.getItem(logoutMarker) === "1"; } catch { return localLogout; }
}
export function setLogoutHidden(hidden: boolean) {
  localLogout = hidden;
  try {
    if (hidden) sessionStorage.setItem(logoutMarker, "1");
    else sessionStorage.removeItem(logoutMarker);
  } catch { /* in-memory fallback */ }
}

// Эндпоинты авторизации сами выдают и проверяют сессию, поэтому skipRefresh.
const auth = { method: "POST", skipRefresh: true } as const;

export const authApi = {
  register: (body: RegisterInput) => request<{ ok: true }>("/auth/register", { ...auth, body }),
  verifyEmail: (body: VerifyEmailInput) => request<void>("/auth/verify-email", { ...auth, body }),
  login: (body: LoginInput) => request<{ user: PublicUser; sessionId: string }>("/auth/login", { ...auth, body }),
  logout: () => request<void>("/auth/logout", auth),
  forgotPassword: (body: ForgotPasswordInput) => request<{ ok: true }>("/auth/forgot-password", { ...auth, body }),
  resetPassword: (body: ResetPasswordInput) => request<void>("/auth/reset-password", { ...auth, body }),
};

// null означает «не авторизован» (штатное состояние, а не ошибка).
// Просроченный access-токен клиент тихо обновляет внутри request().
export async function fetchMe(signal?: AbortSignal): Promise<SessionUser | null> {
  if (logoutHidden()) return null;
  try {
    const { user, sessionId } = await request<{ user: PublicUser; sessionId: string }>("/auth/me", { signal });
    if (sessionId) bindPrivateSession(sessionId);
    return { ...user, sessionId };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}
