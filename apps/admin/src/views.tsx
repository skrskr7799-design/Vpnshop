import { Breadcrumbs, Button, CodeDisplay, DataTable, EmptyState, ErrorState, Icon, MetricCard, PageHeader, Pagination,
  Skeleton, StatusIndicator } from "@vpn/ui";
import { useQuery } from "@tanstack/react-query";
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
  state: "Свежесть", isActive: "В продаже", subscription: "Подписка", ready: "Готов к обработке", author: "Автор",
  id: "ID", status: "Статус", email: "Контакт", userId: "Пользователь", orderId: "Заказ", amountMinor: "Сумма (мин. ед.)",
  amount: "Сумма (мин. ед.)", currency: "Валюта", captured: "Поступления", allocated: "Зачтено",
  unallocated: "Не распределено", refunded: "Возвраты", chargebackDebits: "Списания по спорам",
  chargebackReversals: "Восстановлено по спорам", net: "Итого", active: "Действует", paid: "Зачтено заказов",
  open: "Открыто", panelReady: "Подтверждено панелью", total: "Всего", new: "Новые",
  code: "Код", name: "Название", deviceLimit: "Устройства", attempts: "Попытки", revision: "Ревизия",
  createdAt: "Создано", updatedAt: "Обновлено", providerTime: "Время провайдера", reasonCode: "Причина",
  receivedAt: "Получено", action: "Действие", actorId: "Сотрудник", permission: "Разрешение",
  version: "Версия", category: "Тема", kind: "Тип", role: "Роль", enrollmentState: "Второй фактор",
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
  FRESH: "Актуально", STALE: "Данные устарели", UNAVAILABLE: "Источник недоступен", CONFIRMED: "Подтверждено",
  VERIFY_PENDING: "Требуется сверка", NEEDS_REVIEW: "Требует решения", SUPERSEDED: "Заменено ревизией",
  SUCCEEDED: "Платёж подтверждён", CREATED: "Создана", SUBMITTING: "Запрос отправляется", REVIEW: "Требуется проверка",
  PENDING: "Ожидает", ACTIVE: "Действует", BLOCKED: "Заблокирован", PAID: "Оплата подтверждена",
  FULFILLED: "Выдан", EXPIRED: "Срок истёк", CANCELED: "Отменён", REFUNDED: "Возвращён", RUNNING: "Выполняется",
  RETRY_WAIT: "Ожидает повтора", FAILED: "Ошибка", UNKNOWN: "Исход уточняется", WAITING: "Ожидает",
  AWAITING_CUSTOMER: "Ожидает оплату", WAITING_EXTERNAL: "Ожидает внешнего подтверждения", PROCESSING: "Обрабатывается",
  AWAITING_APPROVAL: "Ожидает одобрения", HELD: "Приостановлено", READY: "Доступ подтверждён",
  WAITING_CUSTOMER: "Ждём клиента", OPEN: "Открыто", RESOLVED: "Закрыто", NOT_REQUESTED: "Без заявки на выдачу",
};
const domainLabels: Record<string, string> = {
  PAYMENT: "Оплата", DELIVERY: "Выдача доступа", ACCESS: "Подключение", OTHER: "Другой вопрос",
  CAPTURE: "Поступление", REFUND: "Возврат", CHARGEBACK_DEBIT: "Списание по спору", CHARGEBACK_REVERSAL: "Возврат списания",
  ADMIN: "Администратор", SUPPORT: "Поддержка", CUSTOMER: "Клиент", STAFF: "Сотрудник",
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
export function Table({ rows, columns, destination }: { rows: Row[]; columns: string[]; destination?: (row: Row) => string }) {
  const location = useLocation();
  const returnTo = location.pathname + location.search;
  if (!rows.length) return <EmptyState title="Записей пока нет"><p className="admin-meta">Попробуйте изменить фильтры.</p></EmptyState>;
  return <div className="table-scroll"><p className="table-hint">Таблицу можно прокручивать по горизонтали.</p><DataTable label="Таблица результатов" columns={columns.map(id => ({ id, label: label(id) }))}>
    {rows.map(row => <tr key={row.id}>{columns.map((key, index) => <td key={key} data-column={key}>{index === 0 && destination
      ? <Link id={"row-" + row.id} state={{ returnTo, focusRow: row.id }} to={destination(row)}>{valueText(row[key])}</Link>
      : key === "id" || key.endsWith("Id") ? <CodeDisplay>{valueText(row[key])}</CodeDisplay> : valueText(row[key])}</td>)}</tr>)}
  </DataTable></div>;
}
type Filter = [key: string, title: string, values?: string[]];
export function List({ title, path, columns, filters = [], destination, children, actions }: {
  title: string; path: string; columns: string[]; filters?: Filter[]; destination?: (row: Row) => string;
  children?: ReactNode; actions?: (rows: Row[]) => ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const queryString = new URLSearchParams();
  for (const [key] of filters) if (params.get(key)) queryString.set(key, params.get(key)!);
  if (params.get("cursor")) queryString.set("cursor", params.get("cursor")!);
  const key = queryString.toString();
  const query = useAdmin<Page>(path + (key ? (path.includes("?") ? "&" : "?") + key : ""));
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
  return <><PageHeader title={title} />{children}
    {(path === "/users" || path === "/orders") && <form className="filters" onSubmit={event => void find(event)}>
      <label>Искать по<select name="kind"><option value="ORDER">ID</option>
        {path === "/users" && <option value="EMAIL">Подтверждённый email</option>}
        {path === "/orders" && finance && <><option value="MERCHANT_REFERENCE">Ссылка продавца</option><option value="TRANSACTION">Движение</option></>}
      </select></label><label>Точное значение<input name="term" required /></label><Button type="submit" loading={finding}>Найти</Button>
      {search && <button type="button" onClick={() => setSearch(undefined)}>Вернуться к списку</button>}
      {searchError && <p role="alert">{searchError}</p>}
    </form>}
    {filters.length > 0 && <form key={filters.map(([key]) => params.get(key)).join("|")} className="filters"
      onSubmit={event => {
        event.preventDefault();
        lookup.current?.abort();
        setFinding(false);
        setSearch(undefined);
        const data = new FormData(event.currentTarget);
        setParams(Object.fromEntries(filters.flatMap(([key]) => data.get(key) ? [[key, String(data.get(key)).trim()]] : [])));
      }}>
      {filters.map(([key, title, values]) => <label key={key}>{title}{values ? <select name={key} defaultValue={params.get(key) ?? ""}>
        <option value="">Все</option>{values.map(value => <option key={value} value={value}>{states[value] ?? domainLabels[value] ?? (value === "true" ? "Да" : value === "false" ? "Нет" : value)}</option>)}
      </select> : <input name={key} defaultValue={params.get(key) ?? ""} />}</label>)}
      <Button type="submit" variant="secondary">Применить фильтры</Button>
    </form>}
    {!search && <RequestState state={query} />}
    {data && <>
      <div className="admin-dataset-title"><h2>{search ? "Результаты поиска" : "Записи"}</h2>
        <p className="admin-meta">{data.items.length} на странице{!search && " · Сначала новые"}</p></div>
      <Table rows={data.items} columns={columns} destination={destination} />{actions?.(data.items)}
      {!search && <Pagination
        onFirst={params.has("cursor") ? () => { const next = new URLSearchParams(params); next.delete("cursor"); setParams(next); } : undefined}
        onNext={data.nextCursor ? () => { const next = new URLSearchParams(params); next.set("cursor", data.nextCursor!); setParams(next); } : undefined} />}
    </>}
  </>;
}
export const orderColumns = ["id", "status", "delivery", "userId", "createdAt"];
export const jobColumns = ["id", "status", "revision", "attempts", "reasonCode", "leaseUntil", "nextAttemptAt"];
export const ticketColumns = ["id", "category", "status", "orderId", "updatedAt"];
export const jobFilters: Filter[] = [["status", "Статус", ["PENDING", "VERIFY_PENDING", "NEEDS_REVIEW", "RUNNING", "CONFIRMED", "RETRY_WAIT", "SUPERSEDED", "FAILED"]],
  ["userId", "ID пользователя"], ["overdue", "Просрочено", ["true"]]];
export const orderFilters: Filter[] = [["userId", "ID пользователя"], ["status", "Статус", ["PENDING", "PAID", "FULFILLED", "REFUNDED", "EXPIRED", "CANCELED"]]];
export const ticketFilters: Filter[] = [["status", "Статус", ["OPEN", "WAITING_CUSTOMER", "RESOLVED"]],
  ["category", "Тема", ["PAYMENT", "DELIVERY", "ACCESS", "OTHER"]], ["orderId", "ID заказа"], ["forUserId", "ID владельца"]];

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

type MetricSource = { state: string; observedAt: string | null; data: unknown };
export function Dashboard() {
  const query = useAdmin<{ asOf: string; alerts: Record<string, unknown>[]; [key: string]: unknown }>("/dashboard", 30_000);
  const finance = useCan("finance:read");
  const keys: Record<string, string> = { users: "Пользователи", subscriptions: "Подписки", orders: "Заказы", finance: "Движения по валюте",
    payments: "Платежи", jobs: "Очередь выдачи", support: "Поддержка", panel: "Remnawave", worker: "Воркер" };
  const headline: Record<string, string> = { users: "total", subscriptions: "active", orders: "paid", support: "open" };
  return <><PageHeader title="Операционный обзор" description="Доступ, денежные движения и состояние сервисов." /><RequestState state={query} />
    {query.data && <>
      <section className="dashboard-lead"><strong>Состояние системы</strong><p>Снимок {valueText(query.data.asOf)}</p></section>
      {query.data.alerts.length > 0 && <section className="panel"><h2>Требуют внимания</h2><ul>{query.data.alerts.map((alert, i) =>
        <li key={i}>{String(alert.kind)} · {String(alert.reasonCode)}</li>)}</ul></section>}
      <div className="grid admin-metrics">{Object.entries(keys).filter(([key]) => key !== "finance" || finance).flatMap(([key, title]) => {
        const source = query.data?.[key] as MetricSource | undefined;
        if (!source) return [];
        const metric = source.data && typeof source.data === "object" && !Array.isArray(source.data)
          ? (source.data as Record<string, unknown>)[headline[key]!] : null;
        const freshness = <><StatusIndicator status={source.state}>{states[source.state] ?? source.state}</StatusIndicator>
          {source.observedAt && <p className="admin-meta">Проверено {valueText(source.observedAt)}</p>}</>;
        return [typeof metric === "number" && source.state === "FRESH" ?
          <MetricCard key={key} label={title} value={valueText(metric)}>{freshness}
            {Object.keys(source.data as object).length > 1 && <Facts data={source.data as Record<string, unknown>}
              keys={Object.keys(source.data as object).filter(name => name !== headline[key])} />}</MetricCard>
          : <section className="panel" key={key}><div className="dashboard-source-heading"><h2>{title}</h2>{freshness}</div>
            {source.data !== null && source.state !== "UNAVAILABLE" && (key === "finance" && Array.isArray(source.data)
              ? <FinanceSummary rows={source.data as Record<string, unknown>[]} /> : valueText(source.data))}</section>];
      })}</div>
    </>}
  </>;
}
export function Detail({ title, path, children }: { title: string; path: string; children: (row: Row, refresh: () => unknown) => ReactNode }) {
  const { id } = useParams();
  const state = useLocation().state as { returnTo?: string; focusRow?: string } | null;
  const fallback = path === "/support/cases" ? "/support" : path;
  const back = state?.returnTo && (state.returnTo === fallback || state.returnTo.startsWith(fallback + "?")) ? state.returnTo : fallback;
  const query = useAdmin<Row>(path + "/" + encodeURIComponent(id ?? ""));
  return <><Breadcrumbs><Link to={back} state={{ focusRow: state?.focusRow }}><Icon name="back" size={16} />К списку</Link></Breadcrumbs>
    <PageHeader title={title} /><RequestState state={query} />{query.data && children(query.data, query.refetch)}</>;
}
export function PlanDetail({ actions }: { actions?: (plan: Row, rows: Row[]) => ReactNode }) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const cursor = params.get("cursor");
  const path = "/plans/" + encodeURIComponent(id ?? "") + "/versions";
  const query = useAdmin<Page & { plan: Row }>(path + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
  return <><Breadcrumbs><Link to="/plans"><Icon name="back" size={16} />К тарифам</Link></Breadcrumbs>
    <PageHeader title="История предложений" description="Действующие предложения и неизменяемые версии условий." /><RequestState state={query} />{query.data && <>
    <section className="panel"><Facts data={query.data.plan} keys={["name", "code", "revision", "deviceLimit", "isActive"]} /></section>
    <Table rows={query.data.items} columns={["id", "version", "name", "amount", "currency", "deviceLimit", "durationMonths", "publishedAt", "withdrawnAt"]} />
    <div className="actions">{cursor && <button onClick={() => setParams({})}>К началу</button>}
      {query.data.nextCursor && <button onClick={() => setParams({ cursor: query.data!.nextCursor! })}>Следующая страница</button>}</div>
    {actions?.(query.data.plan, query.data.items)}
  </>}</>;
}

export function SupportDetail({ command }: { command?: (ticket: Row, refresh: () => unknown) => ReactNode }) {
  const { id } = useParams();
  const [pagination, setPagination] = useSearchParams();
  const query = useAdmin<{ case: Row; messages: Page; history: Page }>("/support/cases/" + encodeURIComponent(id ?? "") + "?" + pagination);
  const state = useLocation().state as { returnTo?: string; focusRow?: string } | null;
  const back = state?.returnTo?.startsWith("/support?") ? state.returnTo : "/support";
  return <><Breadcrumbs><Link to={back} state={{ focusRow: state?.focusRow }}><Icon name="back" size={16} />К обращениям</Link></Breadcrumbs>
    <PageHeader title="Обращение" /><RequestState state={query} />{query.data && <>
    <div className="admin-thread"><section className="panel"><h2>Карточка обращения</h2><Facts data={query.data.case} keys={["id", "userId", "status", "category", "updatedAt"]} />
      {typeof query.data.case.orderId === "string" && <Link to={"/orders/" + query.data.case.orderId}>Связанный заказ</Link>}
    </section>
    <section className="panel"><h2>Переписка</h2><ol className="messages">
      {[...query.data.messages.items].reverse().map(message => <li key={message.id} data-author={message.author}>
        <p>{message.author === "STAFF" ? "Поддержка" : "Клиент"} · {valueText(message.createdAt)}</p><p>{String(message.text)}</p>
      </li>)}</ol>
      {query.data.messages.nextCursor && <button onClick={() => setPagination({ cursor: query.data!.messages.nextCursor! })}>Ранее</button>}
      {pagination.has("cursor") && <button onClick={() => setPagination({})}>К новым сообщениям</button>}
    </section></div>
    <section className="panel"><h2>История статусов</h2><Table rows={query.data.history.items} columns={["status", "author", "reason", "createdAt"]} />
      {query.data.history.nextCursor && <button onClick={() => setPagination({ historyCursor: query.data!.history.nextCursor! })}>Ранние статусы</button>}
    </section>
    {command?.(query.data.case, query.refetch)}
  </>}</>;
}
