export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export async function api<T>(path: string, options: {
  method?: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal; key?: string;
} = {}): Promise<T> {
  const response = await fetch("/api" + path, {
    method: options.method ?? "GET", credentials: "same-origin", cache: "no-store", signal: options.signal,
    headers: { ...(options.body !== undefined && { "Content-Type": "application/json" }),
      ...(options.key && { "Idempotency-Key": options.key }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error?.code ?? "UNAVAILABLE");
  return data as T;
}

const messages: Record<string, string> = {
  VERSION_CONFLICT: "Объект изменился. Обновите данные и проверьте действие.",
  STEP_UP_REQUIRED: "Подтверждение истекло или не соответствует команде. Подтвердите заново.",
  IDEMPOTENCY_CONFLICT: "Этот ключ уже связан с другой операцией.",
  CASE_CHANGED: "Обращение обновилось. Прочитайте новые сообщения перед ответом.",
  INVALID_CODE: "Код неверен или уже использован. Дождитесь следующего кода.",
  INVALID_CREDENTIALS: "Проверьте имя пользователя и пароль.",
  LAST_OWNER: "Должен остаться действующий владелец с постоянным паролем.",
  STAFF_USERNAME_IN_USE: "Это имя пользователя уже занято.",
  REGISTRATION_REFERENCE_MISMATCH: "Номер не соответствует этой заявке. Проверьте его с клиентом.",
  PASSWORD_NOT_CONFIGURED: "У клиента нет подключённого пароля.",
  PASSWORD_RESET_UNAVAILABLE: "Для отправки письма нужен подтверждённый email и доступный вход.",
  EMAIL_UNAVAILABLE: "Почтовая отправка отключена.",
  USER_EMAIL_IN_USE: "Аккаунт с таким адресом уже существует.",
  STAFF_DEACTIVATED: "Сотрудник деактивирован.",
  PASSWORD_MUST_CHANGE: "Выберите пароль, отличный от временного.",
  ACCOUNT_BLOCKED: "Сначала восстановите доступ к аккаунту.",
  INVALID_STAGE: "Этап входа истёк. Начните заново.",
  LAST_ADMIN: "Операция оставит систему без доступного администратора.",
  SAME_APPROVER: "Требуется другой администратор.",
  REFUND_LIMIT: "Эта сумма превышает доступный остаток возврата.",
  STALE_REVISION: "Задача относится к прошлой ревизии. Откройте текущую подписку.",
  COMPENSATION_POLICY_PENDING: "Политика компенсаций ожидает допуска.",
};
export const errorText = (error: unknown) => error instanceof ApiError ?
  messages[error.code] ?? {
    401: "Сессия завершена. Войдите снова.", 403: "У вашей роли нет разрешения.", 404: "Запись не найдена.",
    429: "Слишком много попыток. Повторите позже.",
  }[error.status] ?? "Операция не выполнена. Проверьте данные и повторите запрос." : "Сервер недоступен. Проверьте соединение.";
