const AUTH_PATHS = new Set(["/login", "/register", "/forgot-password", "/verify-email", "/reset-password"]);

// Куда вернуть пользователя после входа. Принимаем только внутренний путь:
// это защита от open redirect, так как значение приходит из query-параметра.
export function sanitizeReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > 300 || !value.startsWith("/") || value.startsWith("//")) return undefined;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const path = value.split(/[?#]/)[0] ?? "";
  if (AUTH_PATHS.has(path)) return undefined;
  return value;
}
