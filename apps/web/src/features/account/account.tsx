import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, Outlet } from "react-router";
import { request } from "../../api/client";
import { ApiError } from "../../api/ApiError";
import { useLogout, useMe } from "../auth/queries";
import "./account.css";

export function useOwner<T>(path: string, refetchInterval?: number) {
  const { data } = useMe();
  return useQuery({
    queryKey: ["owner", data?.id, data?.sessionId, path],
    queryFn: ({ signal }) => request<T>(path, { signal }),
    enabled: !!data, retry: false, refetchInterval,
  });
}

export const date = (value: string | null | undefined) => value
  ? new Date(value).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "—";

export function amount(minor: number | string, currency: string) {
  return new Intl.NumberFormat("ru-RU", { currency, style: "currency" })
    .format(Number(minor) / (currency === "XTR" ? 1 : 100));
}

const errors: Record<string, string> = {
  OFFER_CHANGED: "Предложение изменилось. Проверьте актуальную цену и выберите тариф снова.",
  OFFER_UNAVAILABLE: "Предложение больше недоступно. Выберите другой тариф.",
  PAYMENTS_DISABLED: "Оплата пока недоступна.", REAUTH_REQUIRED: "Подтвердите вход повторно.",
  ACCESS_HELD: "Доступ приостановлен.", ACCESS_EXPIRED: "Действующий период отсутствует.",
  ACCESS_NOT_READY: "Выдача ещё не подтверждена. Попробуйте позже.",
  PANEL_UNAVAILABLE: "Подключение временно недоступно. Попробуйте позже.",
  RETRY_REQUIRED: "Сессия обновилась. Подтвердите действие ещё раз.",
  ORDER_CLOSED: "Окно оплаты заказа закрылось.", ATTEMPT_IN_PROGRESS: "По заказу уже есть платёжная попытка.",
  CASE_RESOLVED: "Обращение закрыто. При необходимости откройте новое.",
};
export const errorMessage = (error: unknown) => error instanceof ApiError ?
  errors[error.code] ?? (error.status === 429 ? "Слишком много запросов. Подождите перед повтором." :
    error.status === 404 ? "Запись недоступна." : error.status === 403 ? "Действие запрещено." :
    error.status === 401 ? "Войдите снова." : "Действие не завершилось. Попробуйте позже.")
  : "Связь прервалась. Проверьте соединение.";

export const labels: Record<string, string> = {
  ACTIVE: "Право действует", READY: "Доступ подтверждён", WAITING: "Ожидает подтверждения", HELD: "Приостановлено",
  SCHEDULED: "Запланировано", EXPIRED: "Срок истёк", EMPTY: "Периода нет", LEGACY_REVIEW: "Требуется сверка",
  NOT_REQUESTED: "Выдача не начата", REVIEW: "Требуется проверка", OPEN: "Открыт", ALLOCATED: "Зачтён",
  CANCELED: "Отменён", LEGACY: "Историческая запись", UNKNOWN: "Исход операции уточняется",
  CAPTURE_RECORDED: "Поступление подтверждено", LATE_CAPTURE: "Позднее поступление",
  REFUNDED: "Возврат подтверждён", PARTIAL_REFUND: "Частичный возврат",
  CREATED: "Создана", SUBMITTING: "Отправляется", AWAITING_CUSTOMER: "Ожидается оплата",
  PROCESSING: "Обрабатывается", SUCCEEDED: "Платёж подтверждён", FAILED: "Отклонена",
  WAITING_CUSTOMER: "Ждём вашего ответа", RESOLVED: "Закрыто",
};
export const label = (state: string) => labels[state] ?? state;

export function AccountShell() {
  const logout = useLogout();
  const { data } = useMe();
  const navigation = [
    ["/account", "Обзор"], ["/account/plans", "Тарифы"], ["/account/subscription", "Подписка"],
    ["/account/connect", "Подключение"], ["/account/orders", "Заказы"], ["/account/security", "Безопасность"],
    ["/account/support", "Поддержка"],
  ];
  return <div className="mzt-account">
    <header className="mzt-top">
      <Link to="/account" className="mzt-wordmark">MZT</Link>
      <button onClick={() => logout.mutate()}>Выйти</button>
    </header>
    <nav className="mzt-nav" aria-label="Разделы кабинета">{navigation.map(([path, title]) =>
      <NavLink end={path === "/account"} key={path} to={path!}>{title}</NavLink>)}</nav>
    <main className="mzt-content"><Outlet key={data?.sessionId} /></main>
  </div>;
}

export function LoadState({ pending, error, retry }: { pending: boolean; error: unknown; retry: () => unknown }) {
  if (pending) return <p role="status">Загрузка…</p>;
  if (error) return <div role="alert"><p>{errorMessage(error)}</p><button onClick={() => void retry()}>Обновить</button></div>;
  return null;
}
