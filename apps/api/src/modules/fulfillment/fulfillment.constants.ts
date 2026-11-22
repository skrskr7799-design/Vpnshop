export const POLL_INTERVAL_MS = 3_000;
export const MAX_JOBS_PER_TICK = 50;

// Сколько раз пробуем при недоступности панели. С экспонентой до 30 минут это около 5 часов.
export const MAX_ATTEMPTS = 15;
export const BACKOFF_BASE_MS = 15_000;
export const BACKOFF_MAX_MS = 30 * 60 * 1000;

// Токен или версия панели неверны: сами не починятся, поэтому опрашиваем редко и не сдаёмся
export const OPERATOR_RETRY_MS = 10 * 60 * 1000;

// The old embedded worker recorded only lockedAt.
export const LEGACY_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_LEASE_MS = 90_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 15_000;
