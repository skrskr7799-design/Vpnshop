export const POLL_INTERVAL_MS = 3_000;
export const MAX_JOBS_PER_TICK = 50;

// Сколько раз пробуем при недоступности панели. С экспонентой до 30 минут это около 5 часов.
export const MAX_ATTEMPTS = 15;
export const BACKOFF_BASE_MS = 15_000;
export const BACKOFF_MAX_MS = 30 * 60 * 1000;

// Токен или версия панели неверны: сами не починятся, поэтому опрашиваем редко и не сдаёмся
export const OPERATOR_RETRY_MS = 10 * 60 * 1000;

// Задача в RUNNING дольше этого считается брошенной (процесс упал). Должно быть заметно больше
// таймаута запросов к панели.
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
