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

type SessionEvent = "logout-started" | "logout-confirmed" | "login";
const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("mzt-account-session") : null;

export function publishSessionEvent(event: SessionEvent) { channel?.postMessage(event); }
export function onSessionEvent(handler: (event: SessionEvent) => void) {
  channel?.addEventListener("message", event => {
    if (["logout-started", "logout-confirmed", "login"].includes(event.data)) handler(event.data);
  });
}

// Эндпоинты авторизации сами выдают и проверяют сессию, поэтому skipRefresh.
const auth = { method: "POST", skipRefresh: true } as const;

type EmailReceipt = { ok: true; emailAvailable?: boolean; registrationReference?: string };

export const authApi = {
  register: (body: RegisterInput) => request<EmailReceipt>("/auth/register", { ...auth, body }),
  resendVerification: (body: ForgotPasswordInput) => request<EmailReceipt>("/auth/resend-verification", { ...auth, body }),
  verifyEmail: (body: VerifyEmailInput) => request<void>("/auth/verify-email", { method: "POST", body }),
  login: (body: LoginInput) => request<{ user: PublicUser; sessionId: string }>("/auth/login", { ...auth, body }),
  changeTemporaryPassword: (body: { email: string; temporaryPassword: string; password: string }) =>
    request<void>("/auth/password/change-temporary", { ...auth, body }),
  logout: () => request<void>("/auth/logout", auth),
  forgotPassword: (body: ForgotPasswordInput) => request<EmailReceipt>("/auth/forgot-password", { ...auth, body }),
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
