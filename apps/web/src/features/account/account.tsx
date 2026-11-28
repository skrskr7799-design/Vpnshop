import { useProductConfig } from "../../config";
import { ProductLinks } from "../../components/ProductLinks";
import type { OwnerSubscription } from "@vpn/shared";
import { useQuery } from "@tanstack/react-query";
import { BrandMark, Button, Drawer, ErrorState, Icon, IconButton, LabyrinthBackground, MobileNavigation, Skeleton, type IconName } from "@vpn/ui";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
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
  MAINTENANCE_MODE: "Магазин на техническом обслуживании.",
  PROVISIONING_UNAVAILABLE: "Подключение новых подписок временно недоступно.",
  SUPPORT_DISABLED: "Приём новых обращений временно прекращён.",
  OFFER_CHANGED: "Предложение изменилось. Проверьте актуальную цену и выберите тариф снова.",
  OFFER_UNAVAILABLE: "Предложение больше недоступно. Выберите другой тариф.",
  PAYMENTS_DISABLED: "Оплата пока недоступна.", REAUTH_REQUIRED: "Подтвердите вход повторно.",
  ACCESS_HELD: "Доступ приостановлен.", ACCESS_EXPIRED: "Действующий период отсутствует.",
  ACCESS_NOT_READY: "Выдача ещё не подтверждена. Попробуйте позже.",
  PANEL_UNAVAILABLE: "Подключение временно недоступно. Попробуйте позже.",
  RETRY_REQUIRED: "Сессия обновилась. Подтвердите действие ещё раз.",
  ORDER_CLOSED: "Окно оплаты заказа закрылось.", ATTEMPT_IN_PROGRESS: "По заказу уже есть платёжная попытка.",
  CASE_RESOLVED: "Обращение завершено. Обновите страницу, чтобы увидеть доступные действия.",
  CASE_STATUS_CONFLICT: "Статус изменился. Обновите обращение и повторите действие.",
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
  WAITING_CUSTOMER: "Ждём вашего ответа", RESOLVED: "Решено", CLOSED: "Закрыто", IN_PROGRESS: "В работе",
};
export const label = (state: string) => labels[state] ?? state;

const navigation: { path: string; title: string; icon: IconName }[] = [
  { path: "/account", title: "Обзор", icon: "grid" },
  { path: "/account/plans", title: "Тарифы", icon: "layers" },
  { path: "/account/subscription", title: "Подписка", icon: "pulse" },
  { path: "/account/connect", title: "Подключение", icon: "connect" },
  { path: "/account/orders", title: "Заказы", icon: "receipt" },
  { path: "/account/support", title: "Поддержка", icon: "support" },
  { path: "/account/security", title: "Безопасность", icon: "key" },
];

const quickLinks = navigation.filter(({ path }) => ["/account", "/account/subscription", "/account/connect"].includes(path));

export function displayDelivery(subscription: NonNullable<OwnerSubscription["subscription"]>) {
  return subscription.delivery.status === "READY" && !subscription.delivery.observationFresh ? "WAITING" : subscription.delivery.status;
}

function subscriptionFraction(summary?: OwnerSubscription) {
  const period = summary?.subscription?.currentPeriod;
  if (!period || summary?.subscription?.rightStatus !== "ACTIVE" || period.kind !== "PURCHASE") return undefined;
  const duration = Date.parse(period.endAt) - Date.parse(period.startAt);
  const remaining = Date.parse(period.effectiveEndAt) - Date.parse(summary.serverTime);
  if (!(duration > 0) || !(remaining > 0)) return undefined;
  return Math.min(1, remaining / duration);
}

export function AccountShell() {
  const logout = useLogout();
  const subscription = useOwner<OwnerSubscription>("/me/subscription");
  const product = useProductConfig().data;
  const brand = product?.product.brandName ?? "MZT";
  const { data } = useMe();
  const { pathname } = useLocation();
  const [menu, setMenu] = useState(false);
  const main = useRef<HTMLElement>(null);
  const active = navigation.find(item => item.path !== "/account" && pathname.startsWith(item.path)) ?? navigation[0]!;
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
    document.title = active.title + " — " + brand;
  }, [pathname, active.title, brand]);
  const links = (close?: () => void) => <nav className="mzt-nav" aria-label="Разделы кабинета">{navigation.map(({ path, title, icon }) =>
    <NavLink end={path === "/account"} key={path} to={path} className="mz-nav-link" onClick={close}><Icon name={icon} size={18} />{title}</NavLink>)}</nav>;
  const exit = <Button variant="quiet" onClick={() => logout.mutate()}><Icon name="out" size={17} />Выйти</Button>;
  return <div className={`mzt-account${pathname === "/account" ? " mzt-account--overview" : ""}`}>
    <LabyrinthBackground remaining={subscription.isError ? undefined : subscriptionFraction(subscription.data)} />
    <a className="mz-skip" href="#account-main">Перейти к содержимому</a>
    <aside className="mzt-rail"><div className="mzt-rail__brand"><Link to="/account" className="mz-brand-home"><BrandMark /></Link><p className="mzt-product-brand">{brand === "MZT" ? "Личный кабинет" : brand}</p></div>{links()}<div className="mzt-rail-exit">{exit}</div></aside>
    <div className="mzt-workspace">
      <header className="mzt-top">
        <div className="mzt-top__mobile"><IconButton icon="menu" label="Открыть меню" aria-expanded={menu} onClick={() => setMenu(true)} />
          <Link to="/account" className="mz-brand-home"><BrandMark /></Link></div>
        <span className="mzt-top__context">{data?.email}</span>
      </header>
      <Drawer open={menu} title="Личный кабинет" onClose={() => setMenu(false)}>{links(() => {
        setMenu(false);
        requestAnimationFrame(() => main.current?.focus({ preventScroll: true }));
      })}<div className="mzt-rail-exit">{exit}</div></Drawer>
      <main id="account-main" className="mzt-content" ref={main} tabIndex={-1}>
        {product?.availability.maintenance && <p><Link to="/maintenance">Техническое обслуживание</Link></p>}
        <Outlet key={data?.sessionId} />
        <footer><ProductLinks kind="legal" /></footer>
      </main>
    </div>
    <MobileNavigation label="Быстрые разделы кабинета" expanded={menu} onMore={() => setMenu(true)}>
      {quickLinks.map(({ path, title, icon }) => <NavLink key={path} end={path === "/account"} to={path}><Icon name={icon} size={19} />{title}</NavLink>)}
    </MobileNavigation>
  </div>;
}

export function LoadState({ pending, error, retry }: { pending: boolean; error: unknown; retry: () => unknown }) {
  if (pending) return <Skeleton />;
  if (error) return <ErrorState message={errorMessage(error)} retry={retry} />;
  return null;
}
