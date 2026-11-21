// Что пошло не так при обращении к панели. По kind воркер решает, что делать дальше.
export type RemnawaveErrorKind =
  | "unavailable" // сеть, таймаут, 5xx, 429: повторить позже
  | "unauthorized" // 401/403: токен неверен или отозван, нужно вмешательство
  | "not_found" // 404
  | "rejected" // прочие 4xx: панель отклонила запрос (например, имя занято)
  | "invalid_response"; // ответ не совпал с ожидаемой схемой (вероятно, другая версия панели)

export class RemnawaveError extends Error {
  constructor(
    readonly kind: RemnawaveErrorKind,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "RemnawaveError";
  }

  // Повтор поможет сам по себе
  get retryable(): boolean {
    return this.kind === "unavailable";
  }

  // Повтор не поможет, пока человек не исправит настройку или версию
  get needsOperator(): boolean {
    return this.kind === "unauthorized" || this.kind === "invalid_response";
  }
}
