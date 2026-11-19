export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Окно, в котором повторное предъявление уже ротированного refresh-токена
// считается гонкой двух вкладок, а не кражей.
export const REFRESH_REUSE_GRACE_MS = 10_000;

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

// Защита от почтового спама на чужой адрес
export const MAX_MAILS_PER_EMAIL_PER_HOUR = 3;

export const ACCESS_COOKIE = "vpn_at";
export const REFRESH_COOKIE = "vpn_rt";
// Refresh-кука уходит только на эндпоинты авторизации
export const REFRESH_COOKIE_PATH = "/api/auth";
