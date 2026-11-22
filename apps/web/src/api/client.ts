import { ApiError } from "./ApiError";

const API_PREFIX = "/api";
const REFRESH_LOCK_NAME = "vpn-session-refresh";
const LAST_REFRESH_KEY = "vpn:last-refresh";
const REFRESH_RACE_ATTEMPTS = 3;

type RequestOptions = {
  method?: "GET" | "HEAD" | "POST" | "DELETE";
  body?: unknown;
  // Эндпоинты авторизации сами не требуют access-токена: 401 на них не означает «протух токен»
  skipRefresh?: boolean;
  signal?: AbortSignal;
  idempotencyKey?: string;
  sessionId?: string;
};

let expectedSession: string | undefined;
let sessionBoundary = new AbortController();
export function resetPrivateRequests() {
  sessionBoundary.abort();
  sessionBoundary = new AbortController();
  expectedSession = undefined;
}
export function bindPrivateSession(sid: string) {
  if (expectedSession && expectedSession !== sid) resetPrivateRequests();
  expectedSession = sid;
}

let onSessionExpired: () => void = () => {};

// Вызывается, когда сессию восстановить нельзя (refresh отклонён).
export function setSessionExpiredHandler(handler: () => void): void {
  onSessionExpired = handler;
}

async function rawRequest<T>(path: string, opts: RequestOptions): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(`${API_PREFIX}${path}`, {
    method: opts.method ?? "GET",
    // Content-Type только вместе с телом: Fastify отклоняет пустое тело с JSON-заголовком
    headers: hasBody || opts.sessionId || opts.idempotencyKey ? {
      ...(hasBody && { "Content-Type": "application/json" }),
      ...(opts.sessionId && { "X-MZT-Session": opts.sessionId }),
      ...(opts.idempotencyKey && { "Idempotency-Key": opts.idempotencyKey }),
    } : undefined,
    cache: "no-store",
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
    signal: opts.signal,
  });

  if (res.ok) {
    const data = res.status === 204 ? undefined : await res.json();
    opts.signal?.throwIfAborted();
    return data as T;
  }

  const payload = (await res.json().catch(() => null)) as {
    error?: { code?: string; issues?: ApiError["issues"] };
  } | null;
  throw new ApiError(res.status, payload?.error?.code ?? "UNKNOWN", payload?.error?.issues);
}

// ───────────── Обновление сессии ─────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readLastRefresh(): number {
  try {
    return Number(localStorage.getItem(LAST_REFRESH_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeLastRefresh(timestamp: number): void {
  try {
    localStorage.setItem(LAST_REFRESH_KEY, String(timestamp));
  } catch {
    // хранилище недоступно (приватный режим): просто теряем оптимизацию
  }
}

// Одна блокировка на все вкладки: refresh-токены одноразовые, и две вкладки,
// обновляющие сессию одновременно, ломали бы друг друга.
function withCrossTabLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  // lib.dom описывает результат request() как вложенный Promise; фактически это Promise<T>
  return locks ? (locks.request(REFRESH_LOCK_NAME, fn) as unknown as Promise<T>) : fn();
}

// true: куки обновлены, исходный запрос можно повторить
// false: сессии больше нет, нужен повторный вход
// throw: сеть или сервер недоступны (пользователя не разлогиниваем)
async function performRefresh(requestStartedAt: number): Promise<boolean> {
  // Пока мы ждали блокировку, другая вкладка уже могла обновить сессию
  if (readLastRefresh() > requestStartedAt) return true;

  for (let attempt = 1; attempt <= REFRESH_RACE_ATTEMPTS; attempt++) {
    try {
      await rawRequest<void>("/auth/refresh", { method: "POST", skipRefresh: true });
      writeLastRefresh(Date.now());
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "REFRESH_RACE") {
        await sleep(250 * attempt);
        continue;
      }
      if (err instanceof ApiError && err.status === 401) return false;
      throw err;
    }
  }
  // Гонку не удалось «пережать», но куки скорее всего уже обновил победитель:
  // пробуем повторить исходный запрос, а не выкидываем пользователя.
  return true;
}

// Единственный refresh на вкладку, сколько бы запросов ни получили 401 одновременно.
let inFlightRefresh: Promise<boolean> | null = null;

function refreshSession(requestStartedAt: number): Promise<boolean> {
  inFlightRefresh ??= withCrossTabLock(() => performRefresh(requestStartedAt)).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

// ───────────── Публичный API клиента ─────────────

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (!opts.skipRefresh) {
    const signal = opts.signal ? AbortSignal.any([opts.signal, sessionBoundary.signal]) : sessionBoundary.signal;
    opts = { ...opts, signal, sessionId: path === "/auth/me" ? undefined : expectedSession };
  }
  const startedAt = Date.now();
  try {
    return await rawRequest<T>(path, opts);
  } catch (err) {
    if (err instanceof ApiError && ["SESSION_CHANGED", "ACCOUNT_BLOCKED"].includes(err.code) && !opts.skipRefresh) {
      onSessionExpired();
    }
    const accessExpired = err instanceof ApiError && err.code === "UNAUTHENTICATED" && !opts.skipRefresh;
    if (!accessExpired) throw err;

    if (!(await refreshSession(startedAt))) {
      onSessionExpired();
      throw err;
    }
    // Ровно одна повторная попытка, без циклов
    opts.signal?.throwIfAborted();
    if (opts.method && !["GET", "HEAD"].includes(opts.method) && !opts.idempotencyKey) {
      throw new ApiError(409, "RETRY_REQUIRED");
    }
    try {
      return await rawRequest<T>(path, opts);
    } catch (retryError) {
      if (retryError instanceof ApiError && retryError.status === 401) onSessionExpired();
      throw retryError;
    }
  }
}
