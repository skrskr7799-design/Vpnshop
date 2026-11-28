import { Breadcrumbs, Button, Card, CodeDisplay, DataTable, EmptyState, ErrorState, Icon, MetricCard, PageHeader, Pagination,
  Skeleton, StatusIndicator, type IconName } from "@vpn/ui";
import { supportCategory, supportPriority, supportStatus } from "@vpn/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { api, errorText } from "./api";
import { useCan, useSession } from "./session";

export type Row = Record<string, unknown> & { id: string };
export type Page = { items: Row[]; nextCursor: string | null };
export function useAdmin<T>(path: string, polling?: number) {
  const session = useSession();
  return useQuery({ queryKey: ["admin", session?.user.id, path], queryFn: ({ signal }) => api<T>(path, { signal }),
    enabled: Boolean(session), retry: false, refetchInterval: polling });
}

export function RequestState({ state }: { state: { isPending: boolean; error: unknown; refetch: () => unknown } }) {
  if (state.isPending) return <Skeleton />;
  return state.error ? <ErrorState message={errorText(state.error)} retry={state.refetch} /> : null;
}
const labels: Record<string, string> = {
  registration: "Новые регистрации", payments: "Новые платежи", support: "Новые обращения", maintenance: "Обслуживание",
  runtimeConfigVersion: "Версия публичной конфигурации", remnawave: "Remnawave", smtp: "SMTP", google: "Google",
  telegram: "Telegram", platega: "Platega",
  subject: "Тема", priority: "Приоритет", assignee: "Ответственный", unread: "Новые события",
  username: "Имя пользователя", displayName: "Отображаемое имя", contactEmail: "Контакт",
  activation: "Активация", emailVerified: "Почта подтверждена", lastLoginAt: "Последний вход",
  activeSessions: "Активные сессии", temporaryUntil: "Временный пароль до",
  state: "Состояние", isActive: "В продаже", subscription: "Подписка", ready: "Готов к обработке", author: "Автор",
  id: "ID", status: "Статус", email: "Контакт", userId: "Пользователь", orderId: "Заказ", amountMinor: "Сумма (мин. ед.)",
  amount: "Сумма (мин. ед.)", currency: "Валюта", captured: "Поступления", allocated: "Зачтено",
  unallocated: "Не распределено", refunded: "Возвраты", chargebackDebits: "Списания по спорам",
  chargebackReversals: "Восстановлено по спорам", net: "Итого", active: "Действует", paid: "Зачтено заказов",
  open: "Открыто", panelReady: "Подтверждено панелью", total: "Всего", new: "Новые",
  code: "Код", name: "Название", deviceLimit: "Устройства", attempts: "Попытки", revision: "Ревизия",
  createdAt: "Создано", updatedAt: "Обновлено", providerTime: "Время провайдера", reasonCode: "Причина",
  receivedAt: "Получено", action: "Действие", actorId: "Сотрудник", permission: "Разрешение",
  version: "Версия", category: "Категория", kind: "Тип", role: "Роль", enrollmentState: "Второй фактор",
  errors: "Ошибки", overdue: "Просрочено", stuck: "Требует сверки", awaiting: "Ожидает оплаты",
  durationMonths: "Месяцы", publishedAt: "Публикация", withdrawnAt: "Снятие", currentRevision: "Текущая ревизия",
  leaseUntil: "Аренда до", nextAttemptAt: "Следующая попытка", expiresAt: "Истекает", observedAt: "Проверено",
  startAt: "Начало", endAt: "Конец", delivery: "Выдача", right: "Право", reason: "Причина",
  blockedReason: "Причина блокировки", blockedAt: "Заблокировано", lease: "Аренда", job: "Задача", money: "Оплата",
  snapshot: "Условия заказа", allocation: "Распределение", period: "Период", observations: "Наблюдения",
  entitlement: "Право", owner: "Владелец", count: "Количество",
  comparison: "Сверка", lastSeenAt: "Активность", userAgent: "Устройство", revokedAt: "Отозвана", current: "Текущая",
};
export const states: Record<string, string> = {
  DEACTIVATED: "Деактивирован", MANUAL: "Ручная", REVOKED: "Отозвана", ENROLLED: "Подключён",
  FRESH: "Актуально", STALE: "Данные устарели", UNAVAILABLE: "Источник недоступен", CONFIRMED: "Подтверждено",
  VERIFY_PENDING: "Требуется сверка", NEEDS_REVIEW: "Требует решения", SUPERSEDED: "Заменено ревизией",
  SUCCEEDED: "Платёж подтверждён", CREATED: "Создана", SUBMITTING: "Запрос отправляется", REVIEW: "Требуется проверка",
  AWAITING_PASSWORD: "Ожидает установки пароля", AWAITING_REVIEW: "Ожидает проверки", EMAIL_CONFIRMATION: "Ожидает письма",
  PENDING: "Ожидает", ACTIVE: "Действует", BLOCKED: "Заблокирован", PAID: "Оплата подтверждена",
  FULFILLED: "Выдан", EXPIRED: "Срок истёк", CANCELED: "Отменён", REFUNDED: "Возвращён", RUNNING: "Выполняется",
  RETRY_WAIT: "Ожидает повтора", FAILED: "Ошибка", UNKNOWN: "Исход уточняется", WAITING: "Ожидает",
  AWAITING_CUSTOMER: "Ожидает оплату", WAITING_EXTERNAL: "Ожидает внешнего подтверждения", PROCESSING: "Обрабатывается",
  AWAITING_APPROVAL: "Ожидает одобрения", HELD: "Приостановлено", READY: "Доступ подтверждён",
  WAITING_CUSTOMER: "Ждём клиента", OPEN: "Ждём поддержки", RESOLVED: "Решено", CLOSED: "Закрыто", IN_PROGRESS: "В работе", NOT_REQUESTED: "Без заявки на выдачу",
};
const domainLabels: Record<string, string> = {
  DISABLED: "Отключено", CONFIGURED_UNVERIFIED: "Настроено · проверка на стенде",
  CONTRACT_BLOCKED: "Контракт не подтверждён", OBLIGATIONS_WITHOUT_PROVIDER: "Есть незавершённые операции · требуется проверка",
  PAYMENT: "Оплата", DELIVERY: "Выдача доступа", ACCESS: "Подключение", OTHER: "Другой вопрос",
  GENERAL: "Общий вопрос", SUBSCRIPTION: "Подписка", TECHNICAL: "Техническая проблема", ACCOUNT: "Аккаунт",
  LOW: "Низкий", NORMAL: "Обычный", HIGH: "Высокий", URGENT: "Срочный",
  CAPTURE: "Поступление", REFUND: "Возврат", CHARGEBACK_DEBIT: "Списание по спору", CHARGEBACK_REVERSAL: "Возврат списания",
  OWNER: "Владелец", ADMIN: "Администратор", SUPPORT: "Поддержка", CUSTOMER: "Клиент", STAFF: "Сотрудник",
};
const label = (key: string) => labels[key] ?? key;
const isDate = (value: string) => /^\d{4}-\d\d-\d\dT/.test(value);
export function valueText(value: unknown): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (typeof value === "string") {
    if (isDate(value)) return new Date(value).toLocaleString("ru-RU");
    return states[value] ? <StatusIndicator status={value}>{states[value]}</StatusIndicator> : domainLabels[value] ?? value;
  }
  if (typeof value === "number") return value.toLocaleString("ru-RU");
  if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) => <li key={index}>{valueText(item)}</li>)}</ul> : "—";
  return <Facts data={value as Record<string, unknown>} />;
}
export function Facts({ data, keys = Object.keys(data) }: { data: Record<string, unknown>; keys?: string[] }) {
  return <dl className="facts">{keys.map(key => <div key={key}><dt>{label(key)}</dt><dd>{valueText(data[key])}</dd></div>)}</dl>;
}
export function Table({ rows, columns, destination, compactUsers }: {
  rows: Row[]; columns: string[]; destination?: (row: Row) => string; compactUsers?: boolean;
}) {
  const location = useLocation();
  const returnTo = location.pathname + location.search;
  if (!rows.length) return <EmptyState title="Записей пока нет"><p className="admin-meta">Попробуйте изменить фильтры.</p></EmptyState>;
  return <div className={compactUsers ? "table-scroll admin-compact-users" : "mz-cut table-scroll table-scroll--records"}>
    <p className="table-hint"><Icon name="arrow" size={15} />Таблицу можно прокручивать по горизонтали.</p>
    <DataTable label="Таблица результатов" columns={columns.map(id => ({ id, label: label(id) }))}>
    {rows.map(row => <tr key={row.id}>{columns.map((key, index) => <td key={key} data-column={key}>{index === 0 && destination
      ? <Link id={"row-" + row.id} state={{ returnTo, focusRow: row.id }} to={destination(row)}>{compactUsers && <Icon name="users" size={19} />}
        {key === "id" ? <CodeDisplay>{row.id}</CodeDisplay> : valueText(row[key])}</Link>
      : key === "id" || key.endsWith("Id") ? <CodeDisplay>{valueText(row[key])}</CodeDisplay> : valueText(row[key])}</td>)}</tr>)}
  </DataTable></div>;
}
type FilterOption = string | { value: string; label: string };
type Filter = [key: string, title: string, values?: readonly FilterOption[]];
export function List({ title, path, columns, filters = [], destination, children, actions, nested = false }: {
  title: string; path: string; columns: string[]; filters?: Filter[]; destination?: (row: Row) => string;
  children?: ReactNode; actions?: (rows: Row[]) => ReactNode; nested?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const queryString = new URLSearchParams();
  for (const [key] of filters) if (params.get(key)) queryString.set(key, params.get(key)!);
  if (params.get("cursor")) queryString.set("cursor", params.get("cursor")!);
  const key = queryString.toString();
  const query = useAdmin<Page>(path + (key ? (path.includes("?") ? "&" : "?") + key : ""), path === "/support/cases" ? 30_000 : undefined);
  const [search, setSearch] = useState<Page>();
  const [finding, setFinding] = useState(false);
  const lookup = useRef<AbortController>(null);
  const state = useLocation().state as { focusRow?: string } | null;
  useEffect(() => () => lookup.current?.abort(), [path]);
  const [searchError, setSearchError] = useState("");
  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const term = String(data.get("term")).trim();
    const kind = String(data.get("kind"));
    lookup.current?.abort();
    const controller = new AbortController();
    lookup.current = controller;
    setFinding(true);
    setSearchError("");
    try {
      const result = await api<Page>(path + "/search", { method: "POST", signal: controller.signal, body: path === "/users"
        ? kind === "EMAIL" ? { verifiedEmail: term } : { userId: term } : { kind, value: term } });
      if (!controller.signal.aborted) setSearch(result);
    } catch (error) { if (!controller.signal.aborted) setSearchError(errorText(error)); }
    finally { if (!controller.signal.aborted) setFinding(false); }
  }
  const finance = useCan("finance:read");
  const data = search ?? query.data;
  useEffect(() => {
    if (!state?.focusRow || !data) return;
    const frame = requestAnimationFrame(() => document.getElementById("row-" + state.focusRow)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [state?.focusRow, data]);
  const filterForm = filters.length > 0 && <form key={filters.map(([key]) => params.get(key)).join("|")} className="mz-cut filters" aria-label="Фильтры списка"
      onSubmit={event => {
        event.preventDefault();
        lookup.current?.abort();
        setFinding(false);
        setSearch(undefined);
        const data = new FormData(event.currentTarget);
        setParams(Object.fromEntries(filters.flatMap(([key]) => data.get(key) ? [[key, String(data.get(key)).trim()]] : [])));
      }}>
      {filters.map(([key, title, values]) => <label key={key}>{title}{values ? <select name={key} defaultValue={params.get(key) ?? ""}>
        <option value="">Все</option>{values.map(option => {
          const value = typeof option === "string" ? option : option.value;
          const text = typeof option === "string" ? states[value] ?? domainLabels[value] ??
            (value === "true" ? "Да" : value === "false" ? "Нет" : value) : option.label;
          return <option key={value} value={value}>{text}</option>;
        })}
      </select> : <input name={key} defaultValue={params.get(key) ?? ""} />}</label>)}
      <Button type="submit" variant="secondary">Применить фильтры</Button>
    </form>;
  return <>{nested ? <h2>{title}</h2> : <PageHeader title={title} />}{children}
    {(path === "/users" || path === "/orders") && <form className={path === "/users" ? "mz-cut filters admin-users-search" : "mz-cut filters"} aria-label="Поиск записи" onSubmit={event => void find(event)}>
      <label>Искать по<select name="kind"><option value="ORDER">ID</option>
        {path === "/users" && <option value="EMAIL">Email</option>}
        {path === "/orders" && finance && <><option value="MERCHANT_REFERENCE">Ссылка продавца</option><option value="TRANSACTION">Движение</option></>}
      </select></label><label>Точное значение<input name="term" required /></label><Button type="submit" loading={finding}>Найти</Button>
      {search && <Button variant="secondary" onClick={() => setSearch(undefined)}>Вернуться к списку</Button>}
      {searchError && <p role="alert">{searchError}</p>}
    </form>}
    {path === "/users" && filterForm ? <details className="admin-users-filter">
      <summary><Icon name="more" size={17} />Фильтры{params.has("status") ? " · выбран статус" : ""}</summary>
      {filterForm}
    </details> : filterForm}
    {!search && <RequestState state={query} />}
    {data && <>
      <div className="admin-dataset-title">{(search || path !== "/users") && <h2>{search ? "Результаты поиска" : "Записи"}</h2>}
        <p className="admin-meta">{data.items.length} на странице{!search && " · Сначала новые"}</p></div>
      <Table rows={data.items} columns={columns} destination={destination} compactUsers={path === "/users"} />{actions?.(data.items)}
      {!search && <Pagination
        onFirst={params.has("cursor") ? () => { const next = new URLSearchParams(params); next.delete("cursor"); setParams(next); } : undefined}
        onNext={data.nextCursor ? () => { const next = new URLSearchParams(params); next.set("cursor", data.nextCursor!); setParams(next); } : undefined} />}
    </>}
  </>;
}
export const orderColumns = ["id", "status", "delivery", "userId", "createdAt"];
export const jobColumns = ["id", "status", "revision", "attempts", "reasonCode", "leaseUntil", "nextAttemptAt"];
export const ticketColumns = ["id", "subject", "category", "status", "priority", "assignee", "unread", "orderId", "updatedAt"];
export const jobFilters: Filter[] = [["status", "Статус", ["PENDING", "VERIFY_PENDING", "NEEDS_REVIEW", "RUNNING", "CONFIRMED", "RETRY_WAIT", "SUPERSEDED", "FAILED"]],
  ["userId", "ID пользователя"], ["overdue", "Просрочено", ["true"]]];
export const orderFilters: Filter[] = [["userId", "ID пользователя"], ["status", "Статус", ["PENDING", "PAID", "FULFILLED", "REFUNDED", "EXPIRED", "CANCELED"]]];
export const ticketFilters: Filter[] = [["search", "Тема или ID"], ["status", "Статус", supportStatus.options],
  ["category", "Категория", supportCategory.options], ["priority", "Приоритет", supportPriority.options],
  ["orderId", "ID заказа"], ["forUserId", "ID владельца"]];

function currencyMovement(value: string, currency: string) {
  if (!/^-?\d+$/.test(value) || !["RUB", "USD", "XTR"].includes(currency)) return value;
  const minor = BigInt(value);
  const formatter = new Intl.NumberFormat("ru-RU", { currency, style: "currency", currencyDisplay: "code",
    ...(currency === "XTR" && { maximumFractionDigits: 0 }) });
  if (currency === "XTR") return formatter.format(minor);
  const whole = minor / 100n;
  const fraction = (minor < 0n ? -minor : minor) % 100n;
  return formatter.formatToParts(minor < 0n && whole === 0n ? -1n : whole).map(part =>
    part.type === "fraction" ? String(fraction).padStart(2, "0") : part.type === "integer" && whole === 0n ? "0" : part.value).join("");
}
function FinanceSummary({ rows }: { rows: Record<string, unknown>[] }) {
  const kinds = ["captured", "refunded", "chargebackDebits", "chargebackReversals", "unallocated"];
  return <div className="admin-finance">{rows.map(row => <section key={String(row.currency)}>
    <h3>{String(row.currency)}</h3><Facts data={Object.fromEntries(kinds.filter(kind => typeof row[kind] === "string")
      .map(kind => [kind, currencyMovement(String(row[kind]), String(row.currency))]))} />
  </section>)}</div>;
}

type MetricSource<T = unknown> = { state: string; observedAt: string | null; data: T | null; reasonCode?: string | null };
type DashboardData = {
  asOf: string;
  users?: MetricSource<Record<string, unknown>>;
  subscriptions?: MetricSource<Record<string, unknown>>;
  orders?: MetricSource<Record<string, unknown>>;
  finance?: MetricSource<Record<string, unknown>[]>;
  payments?: MetricSource;
  jobs?: MetricSource;
  support?: MetricSource<Record<string, unknown>>;
  panel?: MetricSource;
  worker?: MetricSource;
  alerts: { kind: string; reasonCode: string }[];
};
const sourceTitle: Record<string, string> = { panel: "Remnawave", worker: "Воркер", jobs: "Выдача", payments: "Платежи" };
const sourceReason: Record<string, string> = {
  PANEL_UNAVAILABLE: "Панель недоступна", PANEL_PROBE_FAILED: "Не удалось проверить панель",
  NO_HEARTBEAT: "Воркер ещё не отчитался", WORKER_STALE: "Нет свежего отчёта воркера", WORKER_NOT_READY: "Воркер не готов",
  JOBS_OVERDUE: "Есть просроченные задачи выдачи", PAYMENTS_STUCK: "Есть платежи на сверке",
};

function Freshness({ source }: { source: MetricSource }) {
  return <div className="admin-source-freshness">
    <StatusIndicator status={source.state}>{states[source.state] ?? source.state}</StatusIndicator>
    {source.observedAt && <time dateTime={source.observedAt} className="admin-meta">{valueText(source.observedAt)}</time>}
    {source.reasonCode && <p className="admin-meta">{sourceReason[source.reasonCode] ?? source.reasonCode}</p>}
  </div>;
}

function DashboardMetric({ title, icon, source, field, detailField }: {
  title: string; icon: IconName; source?: MetricSource<Record<string, unknown>>; field: string; detailField?: string;
}) {
  return <MetricCard label={title} icon={icon} value={source?.state === "FRESH" ? valueText(source.data?.[field]) : "—"}>
    {source ? <Freshness source={source} /> : <p className="admin-meta">Нет данных</p>}
    {detailField && source?.state === "FRESH" && typeof source.data?.[detailField] === "number" &&
      <p className="admin-meta">{label(detailField)} {valueText(source.data[detailField])}</p>}
  </MetricCard>;
}

function DashboardSource({ title, source }: { title: string; source?: MetricSource }) {
  return <section className="admin-dashboard-source"><h3>{title}</h3>
    {source ? <><Freshness source={source} />{source.data !== null && source.state !== "UNAVAILABLE" && valueText(source.data)}</>
      : <p className="admin-meta">Нет данных</p>}
  </section>;
}

function DashboardServices({ dashboard }: { dashboard: DashboardData }) {
  const status = useAdmin<{ asOf: string; services: (MetricSource & { key: string })[] }>("/operations/status", 30_000);
  // The dashboard and service endpoints can be observed at different times.
  const sources = status.data?.services ?? [
    ...(dashboard.panel ? [{ ...dashboard.panel, key: "panel" }] : []),
    ...(dashboard.worker ? [{ ...dashboard.worker, key: "worker" }] : []),
  ];
  return <Card>
    <div className="admin-panel-title"><h2><Icon name="pulse" size={19} />Сервисы</h2>
      <Link className="admin-inline-link" to="/operations" aria-label="Все сервисы"><Icon name="arrow" size={17} /></Link></div>
    {status.isError && <RequestState state={status} />}
    {!sources.length && !status.isError && <RequestState state={status} />}
    {sources.map(source => <DashboardSource key={source.key} title={sourceTitle[source.key] ?? source.key}
      source={status.isError && source.state === "FRESH" ? { ...source, state: "STALE" } : source} />)}
    {!status.isPending && !status.isError && !sources.length && <p className="admin-meta">Наблюдений пока нет.</p>}
  </Card>;
}

function RecentUsers() {
  const users = useAdmin<Page>("/users?limit=3");
  return <Card>
    <div className="admin-panel-title"><h2><Icon name="users" size={19} />Последние пользователи</h2>
      <Link className="admin-inline-link" to="/users">Все пользователи <Icon name="arrow" size={15} /></Link></div>
    <RequestState state={users} />
    {users.data && !users.isError && <Table rows={users.data.items} columns={["email", "status", "createdAt"]}
      destination={row => `/users/${row.id}`} compactUsers />}
  </Card>;
}

export function Dashboard() {
  const query = useAdmin<DashboardData>("/dashboard", 30_000);
  const finance = useCan("finance:read");
  const services = useCan("ops:read");
  const canReadUsers = useCan("users:read");
  const data = query.data;
  const movements = finance ? data?.finance : undefined;
  return <div className="admin-dashboard">
    <PageHeader title="Админ-панель MZT" description="Управление сервисом, пользователями и подписками." />
    <RequestState state={query} />
    {data && !query.isError && <>
      <div className="admin-balance-kpis">
        <DashboardMetric title="Пользователи" icon="users" source={data.users} field="total" detailField="new" />
        <DashboardMetric title="Активные подписки" icon="layers" source={data.subscriptions} field="active" detailField="panelReady" />
        <DashboardMetric title="Зачтённые заказы" icon="receipt" source={data.orders} field="paid" />
        {finance ? <MetricCard label="Движения по валюте" icon="money" value={movements?.state === "FRESH" && movements.data?.length
          ? <div className="admin-currency-values">{movements.data.map(row => <p key={String(row.currency)}>
            {typeof row.captured === "string" ? currencyMovement(row.captured, String(row.currency)) : "—"}</p>)}</div> : "—"}>
          {movements ? <><p className="admin-meta">Поступления за период</p><Freshness source={movements} /></> : <p className="admin-meta">Нет данных</p>}
        </MetricCard> : <DashboardMetric title="Открытые обращения" icon="support" source={data.support} field="open" />}
      </div>
      <div className="admin-balance-grid admin-balance-grid--primary">
        <Card>
          <div className="admin-panel-title"><h2><Icon name="pulse" size={19} />Рабочие показатели</h2>
            <time className="admin-meta" dateTime={data.asOf}>Снимок {valueText(data.asOf)}</time></div>
          <div className="admin-workstream">
            <DashboardSource title="Платежи" source={data.payments} />
            <DashboardSource title="Очередь выдачи" source={data.jobs} />
          </div>
          {movements?.data?.length && movements.state !== "UNAVAILABLE" ? <FinanceSummary rows={movements.data} /> : null}
        </Card>
        {services && <DashboardServices dashboard={data} />}
      </div>
      <div className="admin-balance-grid admin-balance-grid--secondary">
        {canReadUsers && <RecentUsers />}
        <Card>
          <div className="admin-panel-title"><h2><Icon name="warning" size={19} />Требуют внимания</h2></div>
          {data.alerts.length ? <ul className="admin-alert-list">{data.alerts.map(({ kind, reasonCode }) =>
            <li key={kind + reasonCode}><Icon name="pulse" size={16} />{sourceReason[reasonCode] ?? reasonCode}</li>)}</ul>
            : <p className="admin-meta">Открытых предупреждений нет.</p>}
          <DashboardSource title="Поддержка" source={data.support} />
        </Card>
      </div>
    </>}
  </div>;
}

export function Detail({ title, path, children, hideTitle = false }: {
  title: string; path: string; children: (row: Row, refresh: () => unknown) => ReactNode; hideTitle?: boolean;
}) {
  const { id } = useParams();
  const state = useLocation().state as { returnTo?: string; focusRow?: string } | null;
  const fallback = path === "/support/cases" ? "/support" : path;
  const back = state?.returnTo && (state.returnTo === fallback || state.returnTo.startsWith(fallback + "?")) ? state.returnTo : fallback;
  const query = useAdmin<Row>(path + "/" + encodeURIComponent(id ?? ""));
  return <><Breadcrumbs><Link to={back} state={{ focusRow: state?.focusRow }}><Icon name="back" size={16} />К списку</Link></Breadcrumbs>
    {!hideTitle && <PageHeader title={title} />}<RequestState state={query} />{query.data && children(query.data, query.refetch)}</>;
}
export function PlanDetail({ actions }: { actions?: (plan: Row, rows: Row[]) => ReactNode }) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const cursor = params.get("cursor");
  const path = "/plans/" + encodeURIComponent(id ?? "") + "/versions";
  const query = useAdmin<Page & { plan: Row }>(path + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
  return <><Breadcrumbs><Link to="/plans"><Icon name="back" size={16} />К тарифам</Link></Breadcrumbs>
    <PageHeader title="История предложений" description="Действующие предложения и неизменяемые версии условий." /><RequestState state={query} />{query.data && <>
    <section className="mz-card panel"><Facts data={query.data.plan} keys={["name", "code", "revision", "deviceLimit", "isActive"]} /></section>
    <Table rows={query.data.items} columns={["id", "version", "name", "amount", "currency", "deviceLimit", "durationMonths", "publishedAt", "withdrawnAt"]} />
    <Pagination onFirst={cursor ? () => setParams({}) : undefined}
      onNext={query.data.nextCursor ? () => setParams({ cursor: query.data!.nextCursor! }) : undefined} />
    {actions?.(query.data.plan, query.data.items)}
  </>}</>;
}

export function SupportDetail({ command }: { command?: (ticket: Row, refresh: () => unknown) => ReactNode }) {
  const { id } = useParams();
  const [pagination, setPagination] = useSearchParams();
  const cache = useQueryClient();
  const canReadUsers = useCan("users:read");
  const path = "/support/cases/" + encodeURIComponent(id ?? "");
  const query = useAdmin<{ case: Row; readThrough?: string; messages: Page; history: Page }>(path + "?" + pagination, 30_000);
  const through = query.data?.readThrough;
  const unread = query.data?.case.unread;
  useEffect(() => {
    if (!through || !unread) return;
    void api(path + "/read", { method: "POST", body: { through } })
      .then(() => cache.invalidateQueries({ predicate: entry => String(entry.queryKey.at(-1)).startsWith("/support/cases?") ||
        entry.queryKey.at(-1) === "/support/cases" })).catch(() => {});
  }, [cache, path, through, unread, query.dataUpdatedAt]);
  const state = useLocation().state as { returnTo?: string; focusRow?: string } | null;
  const back = state?.returnTo?.startsWith("/support?") ? state.returnTo : "/support";
  return <><Breadcrumbs><Link to={back} state={{ focusRow: state?.focusRow }}><Icon name="back" size={16} />К обращениям</Link></Breadcrumbs>
    <PageHeader title="Обращение" /><RequestState state={query} />{query.data && <>
    <div className="admin-thread"><section className="mz-card panel"><h2>Карточка обращения</h2><Facts data={query.data.case} keys={["id", "subject", "userId", "status", "category", "priority", "assignee", "updatedAt"]} />
      {canReadUsers && typeof query.data.case.userId === "string" && <p><Link to={"/users/" + query.data.case.userId}>Карточка пользователя</Link></p>}
      {typeof query.data.case.orderId === "string" && <Link to={"/orders/" + query.data.case.orderId}>Связанный заказ</Link>}
    </section>
    <section className="mz-card panel"><h2>Переписка</h2><ol className="messages">
      {[...query.data.messages.items].reverse().map(message => <li key={message.id} data-author={message.author}>
        <p>{message.author === "STAFF" ? "Поддержка" : "Клиент"} · {valueText(message.createdAt)}</p><p>{String(message.text)}</p>
      </li>)}</ol>
      <div className="mz-actions">
        {query.data.messages.nextCursor && <Button variant="secondary" onClick={() => setPagination({ cursor: query.data!.messages.nextCursor! })}>Ранее</Button>}
        {pagination.has("cursor") && <Button variant="secondary" onClick={() => setPagination({})}>К новым сообщениям</Button>}
      </div>
    </section></div>
    <section className="mz-card panel"><h2>История статусов</h2><Table rows={query.data.history.items} columns={["status", "author", "reason", "createdAt"]} />
      {query.data.history.nextCursor && <Button variant="secondary" onClick={() => setPagination({ historyCursor: query.data!.history.nextCursor! })}>Ранние статусы</Button>}
    </section>
    {command?.(query.data.case, query.refetch)}
  </>}</>;
}
