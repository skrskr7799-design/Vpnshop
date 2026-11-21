import { z } from "zod";
import { RemnawaveError } from "./remnawave.errors";
import {
  internalSquadsResponseSchema,
  metadataResponseSchema,
  userResponseSchema,
  type RemnawaveUser,
  type RemnawaveUserStatus,
} from "./remnawave.schemas";

// Маршруты в точности как в официальном контракте (проверяется тестом).
export const REMNAWAVE_ROUTES = {
  users: "/api/users/",
  userByUsername: (username: string) => `/api/users/by-username/${encodeURIComponent(username)}`,
  internalSquads: "/api/internal-squads/",
  metadata: "/api/system/metadata",
} as const;

export type RemnawaveClientConfig = {
  baseUrl: string;
  token: string;
  /** X-Api-Key для панели, закрытой Caddy */
  apiKey?: string;
  /** Слать x-forwarded-for/proto: для прямого доступа к панели по внутренней сети */
  trustedProxyHeaders?: boolean;
  timeoutMs?: number;
  /** Сколько раз повторять безопасные (GET) запросы при сбоях сети и 5xx */
  readRetries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
};

export type CreateUserInput = {
  username: string; // 3-36 символов: буквы, цифры, _ и -
  expireAt: Date;
  hwidDeviceLimit: number;
  activeInternalSquads: string[];
  status?: "ACTIVE" | "DISABLED";
  /** 0 это безлимит */
  trafficLimitBytes?: number;
};

export type UpdateUserInput = {
  id: number;
  expireAt?: Date;
  /** Вручную можно выставить только ACTIVE или DISABLED */
  status?: "ACTIVE" | "DISABLED";
  hwidDeviceLimit?: number | null;
};

type RequestOptions<T> = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  schema: z.ZodType<T>;
  body?: unknown;
};

const TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RemnawaveClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: RemnawaveClientConfig) {
    this.baseUrl = config.baseUrl;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Версия панели: нужна, чтобы заметить несовместимость на старте */
  async getMetadata(): Promise<{ version: string }> {
    const { response } = await this.request({
      method: "GET",
      path: REMNAWAVE_ROUTES.metadata,
      schema: metadataResponseSchema,
    });
    return { version: response.version };
  }

  /** null, если пользователя нет (404) */
  async getUserByUsername(username: string): Promise<RemnawaveUser | null> {
    try {
      const { response } = await this.request({
        method: "GET",
        path: REMNAWAVE_ROUTES.userByUsername(username),
        schema: userResponseSchema,
      });
      return response;
    } catch (err) {
      if (err instanceof RemnawaveError && err.kind === "not_found") return null;
      throw err;
    }
  }

  async createUser(input: CreateUserInput): Promise<RemnawaveUser> {
    const { response } = await this.request({
      method: "POST",
      path: REMNAWAVE_ROUTES.users,
      schema: userResponseSchema,
      body: toCreateBody(input),
    });
    return response;
  }

  async updateUser(input: UpdateUserInput): Promise<RemnawaveUser> {
    const { response } = await this.request({
      method: "PATCH",
      path: REMNAWAVE_ROUTES.users,
      schema: userResponseSchema,
      body: toUpdateBody(input),
    });
    return response;
  }

  async listInternalSquads(): Promise<{ uuid: string; name: string }[]> {
    const { response } = await this.request({
      method: "GET",
      path: REMNAWAVE_ROUTES.internalSquads,
      schema: internalSquadsResponseSchema,
    });
    return response.internalSquads;
  }

  // ───────────── транспорт ─────────────

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.config.token}`,
    };
    if (hasBody) headers["Content-Type"] = "application/json";
    if (this.config.apiKey) headers["X-Api-Key"] = this.config.apiKey;
    if (this.config.trustedProxyHeaders) {
      // Так панель принимает запросы мимо своего reverse proxy (см. официальный пример SDK)
      headers["x-forwarded-for"] = "127.0.0.1";
      headers["x-forwarded-proto"] = "https";
    }
    return headers;
  }

  private async request<T>(opts: RequestOptions<T>): Promise<T> {
    // Повторяем только чтение. Запись не повторяем здесь: за идемпотентность отвечает
    // вызывающий код (задача выдачи подписки), иначе можно применить действие дважды.
    const retries = opts.method === "GET" ? (this.config.readRetries ?? 2) : 0;
    let lastError: RemnawaveError | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.requestOnce(opts);
      } catch (err) {
        if (!(err instanceof RemnawaveError) || !err.retryable) throw err;
        lastError = err;
        if (attempt < retries) await sleep((this.config.retryDelayMs ?? 300) * 2 ** attempt);
      }
    }
    throw lastError!;
  }

  private async requestOnce<T>({ method, path, body, schema }: RequestOptions<T>): Promise<T> {
    const hasBody = body !== undefined;
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        headers: this.headers(hasBody),
        body: hasBody ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.name : "error";
      throw new RemnawaveError("unavailable", null, `Remnawave ${method} ${path}: ${reason}`);
    }

    if (!res.ok) throw await toHttpError(res, method, path);

    try {
      return schema.parse(await res.json());
    } catch {
      throw new RemnawaveError(
        "invalid_response",
        res.status,
        `Remnawave ${method} ${path}: ответ не совпал со схемой (проверьте версию панели)`,
      );
    }
  }
}

async function toHttpError(res: Response, method: string, path: string): Promise<RemnawaveError> {
  // Тело ошибки в контракте не описано: берём message, если он есть, и обрезаем
  let detail = "";
  try {
    const json = (await res.json()) as { message?: unknown };
    const message = Array.isArray(json.message) ? json.message.join("; ") : json.message;
    if (typeof message === "string") detail = `: ${message.slice(0, 300)}`;
  } catch {
    // тело не JSON
  }
  const text = `Remnawave ${method} ${path} вернул ${res.status}${detail}`;

  if (res.status === 401 || res.status === 403) return new RemnawaveError("unauthorized", res.status, text);
  if (res.status === 404) return new RemnawaveError("not_found", res.status, text);
  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    return new RemnawaveError("unavailable", res.status, text);
  }
  return new RemnawaveError("rejected", res.status, text);
}

// ───────────── тела запросов ─────────────

export function toCreateBody(input: CreateUserInput) {
  return {
    username: input.username,
    status: input.status ?? "ACTIVE",
    expireAt: input.expireAt.toISOString(),
    trafficLimitBytes: input.trafficLimitBytes ?? 0,
    trafficLimitStrategy: "NO_RESET" as const,
    hwidDeviceLimit: input.hwidDeviceLimit,
    activeInternalSquads: input.activeInternalSquads,
  };
}

export function toUpdateBody(input: UpdateUserInput) {
  return {
    id: input.id,
    ...(input.expireAt && { expireAt: input.expireAt.toISOString() }),
    ...(input.status && { status: input.status satisfies RemnawaveUserStatus }),
    ...(input.hwidDeviceLimit !== undefined && { hwidDeviceLimit: input.hwidDeviceLimit }),
  };
}
