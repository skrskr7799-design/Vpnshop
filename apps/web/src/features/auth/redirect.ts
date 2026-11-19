const DEFAULT_TARGET = "/account";
const AUTH_PATHS = new Set(["/login", "/register", "/forgot-password", "/verify-email", "/reset-password"]);

// Куда вернуть пользователя после входа. Берём только внутренний путь из состояния роутера:
// это защита от open redirect и от возврата на саму страницу входа.
export function getRedirectTarget(state: unknown): string {
  const from = (state as { from?: Record<string, unknown> } | null)?.from;
  const pathname = from?.pathname;
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) {
    return DEFAULT_TARGET;
  }
  if (AUTH_PATHS.has(pathname)) return DEFAULT_TARGET;

  const search = typeof from?.search === "string" ? from.search : "";
  const hash = typeof from?.hash === "string" ? from.hash : "";
  return pathname + search + hash;
}
