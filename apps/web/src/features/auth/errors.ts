import { ApiError } from "../../api/ApiError";

const BY_CODE: Record<string, string> = {
  REGISTRATION_CLOSED: "Новая регистрация временно закрыта. Вход в существующий аккаунт доступен.",
  MAINTENANCE_MODE: "Магазин на техническом обслуживании. Попробуйте позднее.",
  LOGIN_SESSION_UNCONFIRMED: "Не удалось подтвердить вход. Повторите попытку.",
  INVALID_CREDENTIALS: "Неверный email или пароль.",
  ACTIVATION_PENDING: "Аккаунт ожидает активации. Подтвердите адрес или обратитесь к оператору магазина.",
  EXPLICIT_LINK_REQUIRED: "Войдите существующим способом и подключите Google в разделе «Безопасность».",
  EMAIL_UNAVAILABLE: "Подтверждение по почте сейчас недоступно.",
  ACCOUNT_BLOCKED: "Аккаунт заблокирован. Напишите в поддержку.",
  TEMPORARY_PASSWORD: "Перед входом задайте свой пароль.",
  PASSWORD_MUST_CHANGE: "Выберите пароль, отличный от временного.",
  INVALID_TOKEN: "Ссылка недействительна или устарела.",
  BAD_ORIGIN: "Запрос отклонён. Обновите страницу и повторите.",
  VALIDATION_ERROR: "Проверьте введённые данные.",
  // Вход через внешние сервисы (коды приходят в адресной строке после редиректа)
  OAUTH_DENIED: "Вход отменён. Попробуйте ещё раз.",
  OAUTH_STATE: "Время входа истекло или страница была открыта повторно. Начните вход заново.",
  OAUTH_FAILED: "Не удалось войти через внешний сервис. Повторите позже или используйте другой способ.",
  EMAIL_NOT_VERIFIED: "Почта в этом аккаунте Google не подтверждена, войти с ней нельзя.",
  TELEGRAM_PROFILE_MISSING: "Telegram не передал данные профиля. Разрешите доступ к профилю и повторите.",
  IDENTITY_TAKEN: "Этот аккаунт уже привязан к другому профилю.",
  PROVIDER_ALREADY_LINKED: "К вашему профилю уже подключён другой аккаунт этого сервиса.",
  LINK_CONFLICT: "Не удалось подключить аккаунт. Повторите попытку.",
  UNAUTHENTICATED: "Войдите, чтобы подключить аккаунт.",
  PROVIDER_DISABLED: "Этот способ входа сейчас недоступен.",
};

// Сообщение по коду из адресной строки (например, ?error=OAUTH_DENIED)
export const getMessageByCode = (code: string): string =>
  BY_CODE[code] ?? "Не удалось выполнить действие. Повторите позже.";

// Текст ошибки для пользователя: что случилось и что делать дальше.
export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const known = BY_CODE[error.code];
    if (known) return known;
    if (error.status === 429) return "Слишком много попыток. Подождите несколько минут и повторите.";
    if (error.status >= 500) return "Сервис временно недоступен. Повторите позже.";
  }
  // fetch бросает TypeError, когда нет сети
  if (error instanceof TypeError) return "Нет связи с сервером. Проверьте интернет и повторите.";
  return "Не удалось выполнить запрос. Повторите позже.";
}

export const isInvalidToken = (error: unknown): boolean => error instanceof ApiError && error.code === "INVALID_TOKEN";
