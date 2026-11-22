import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
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
  if (state.isPending) return <p role="status">Загрузка…</p>;
  return state.error ? <div role="alert"><p>{errorText(state.error)}</p><button onClick={() => void state.refetch()}>Обновить</button></div> : null;
}
const labels: Record<string, string> = {
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
  comparison: "Сверка", lastSeenAt: "Активность", userAgent: "Устройство", revokedAt: "Отозвана", current: "Текущая",
};
const states: Record<string, string> = {
  FRESH: "Актуально", STALE: "Данные устарели", UNAVAILABLE: "Источник недоступен", CONFIRMED: "Подтверждено",
  VERIFY_PENDING: "Требуется сверка", NEEDS_REVIEW: "Требует решения", SUPERSEDED: "Заменено ревизией",
  WAITING_CUSTOMER: "Ждём клиента", OPEN: "Открыто", RESOLVED: "Закрыто", NOT_REQUESTED: "Без заявки на выдачу",
};
const label = (key: string) => labels[key] ?? key;
const isDate = (value: string) => /^\d{4}-\d\d-\d\dT/.test(value);
export function valueText(value: unknown): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (typeof value === "string") return isDate(value) ? new Date(value).toLocaleString("ru-RU") : states[value] ?? value;
  if (typeof value === "number") return value.toLocaleString("ru-RU");
  if (Array.isArray(value)) return value.length ? <ul>{value.map((item, index) => <li key={index}>{valueText(item)}</li>)}</ul> : "—";
  return <Facts data={value as Record<string, unknown>} />;
}
export function Facts({ data, keys = Object.keys(data) }: { data: Record<string, unknown>; keys?: string[] }) {
  return <dl className="facts">{keys.map(key => <div key={key}><dt>{label(key)}</dt><dd>{valueText(data[key])}</dd></div>)}</dl>;
}
export function Table({ rows, columns, destination }: { rows: Row[]; columns: string[]; destination?: (row: Row) => string }) {
  if (!rows.length) return <p>Записей пока нет.</p>;
  return <div className="table-scroll" role="region" aria-label="Таблица результатов" tabIndex={0}><table>
    <thead><tr>{columns.map(key => <th key={key} scope="col">{label(key)}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}>{columns.map((key, index) => <td key={key}>{index === 0 && destination
      ? <Link to={destination(row)}>{valueText(row[key])}</Link> : valueText(row[key])}</td>)}</tr>)}</tbody>
  </table></div>;
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
  const [searchError, setSearchError] = useState("");
  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const term = String(data.get("term")).trim();
    const kind = String(data.get("kind"));
    setSearchError("");
    try {
      setSearch(await api<Page>(path + "/search", { method: "POST", body: path === "/users"
        ? kind === "EMAIL" ? { verifiedEmail: term } : { userId: term } : { kind, value: term } }));
    } catch (error) { setSearchError(errorText(error)); }
  }
  const finance = useCan("finance:read");
  const data = search ?? query.data;
  return <><h1>{title}</h1>{children}
    {(path === "/users" || path === "/orders") && <form className="filters" onSubmit={event => void find(event)}>
      <label>Искать по<select name="kind"><option value="ORDER">ID</option>
        {path === "/users" && <option value="EMAIL">Подтверждённый email</option>}
        {path === "/orders" && finance && <><option value="MERCHANT_REFERENCE">Ссылка продавца</option><option value="TRANSACTION">Движение</option></>}
      </select></label><label>Точное значение<input name="term" required /></label><button>Найти</button>
      {search && <button type="button" onClick={() => setSearch(undefined)}>Вернуться к списку</button>}
      {searchError && <p role="alert">{searchError}</p>}
    </form>}
    {filters.length > 0 && <form key={filters.map(([key]) => params.get(key)).join("|")} className="filters"
      onSubmit={event => {
        event.preventDefault();
        setSearch(undefined);
        const data = new FormData(event.currentTarget);
        setParams(Object.fromEntries(filters.flatMap(([key]) => data.get(key) ? [[key, String(data.get(key)).trim()]] : [])));
      }}>
      {filters.map(([key, title, values]) => <label key={key}>{title}{values ? <select name={key} defaultValue={params.get(key) ?? ""}>
        <option value="">Все</option>{values.map(value => <option key={value}>{value}</option>)}
      </select> : <input name={key} defaultValue={params.get(key) ?? ""} />}</label>)}
      <button>Применить фильтры</button>
    </form>}
    <RequestState state={query} />
    {data && <><Table rows={data.items} columns={columns} destination={destination} />{actions?.(data.items)}
      {!search && <div className="actions">
        {params.has("cursor") && <button onClick={() => { const next = new URLSearchParams(params); next.delete("cursor"); setParams(next); }}>К началу</button>}
        {data.nextCursor && <button onClick={() => { const next = new URLSearchParams(params); next.set("cursor", data.nextCursor!); setParams(next); }}>Следующая страница</button>}
      </div>}
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
  ["category", "Тема", ["PAYMENT", "DELIVERY", "ACCESS", "OTHER"]], ["orderId", "ID заказа"]];

export function Dashboard() {
  const query = useAdmin<{ asOf: string; alerts: Record<string, unknown>[]; [key: string]: unknown }>("/dashboard", 30_000);
  const keys: Record<string, string> = { users: "Пользователи", subscriptions: "Подписки", orders: "Заказы", finance: "Движения по валюте",
    payments: "Платежи", jobs: "Очередь выдачи", support: "Поддержка", panel: "Remnawave", worker: "Воркер" };
  return <><h1>Операционный обзор</h1><RequestState state={query} />
    {query.data && <><p>Снимок {valueText(query.data.asOf)}</p>
      {query.data.alerts.length > 0 && <section className="panel"><h2>Оповещения</h2><ul>{query.data.alerts.map((alert, i) =>
        <li key={i}>{String(alert.kind)} · {String(alert.reasonCode)}</li>)}</ul></section>}
      <div className="grid">{Object.entries(keys).flatMap(([key, title]) => {
        const source = query.data?.[key] as { state: string; observedAt: string | null; data: unknown };
        return source ? [<section className="panel" key={key}><h2>{title}</h2>
          <p><strong>{valueText(source.state)}</strong>{source.observedAt && <> · {valueText(source.observedAt)}</>}</p>
          {source.data !== null && valueText(source.data)}
        </section>] : [];
      })}</div>
    </>}
  </>;
}
export function Detail({ title, path, children }: { title: string; path: string; children: (row: Row, refresh: () => unknown) => ReactNode }) {
  const { id } = useParams();
  const query = useAdmin<Row>(path + "/" + encodeURIComponent(id ?? ""));
  return <><h1>{title}</h1><RequestState state={query} />{query.data && children(query.data, query.refetch)}</>;
}
export function PlanDetail({ actions }: { actions?: (plan: Row, rows: Row[]) => ReactNode }) {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const cursor = params.get("cursor");
  const path = "/plans/" + encodeURIComponent(id ?? "") + "/versions";
  const query = useAdmin<Page & { plan: Row }>(path + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
  return <><h1>История предложений</h1><RequestState state={query} />{query.data && <>
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
  return <><h1>Обращение</h1><RequestState state={query} />{query.data && <>
    <section className="panel"><Facts data={query.data.case} keys={["id", "userId", "status", "category", "updatedAt"]} />
      {typeof query.data.case.orderId === "string" && <Link to={"/orders/" + query.data.case.orderId}>Связанный заказ</Link>}
    </section>
    <section className="panel"><h2>Переписка</h2><ol className="messages">
      {[...query.data.messages.items].reverse().map(message => <li key={message.id}>
        <p>{message.author === "STAFF" ? "Поддержка" : "Клиент"} · {valueText(message.createdAt)}</p><p>{String(message.text)}</p>
      </li>)}</ol>
      {query.data.messages.nextCursor && <button onClick={() => setPagination({ cursor: query.data!.messages.nextCursor! })}>Ранее</button>}
      {pagination.has("cursor") && <button onClick={() => setPagination({})}>К новым сообщениям</button>}
    </section>
    <section className="panel"><h2>История статусов</h2><Table rows={query.data.history.items} columns={["status", "author", "reason", "createdAt"]} />
      {query.data.history.nextCursor && <button onClick={() => setPagination({ historyCursor: query.data!.history.nextCursor! })}>Ранние статусы</button>}
    </section>
    {command?.(query.data.case, query.refetch)}
  </>}</>;
}
