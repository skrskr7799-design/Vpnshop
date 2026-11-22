import { Breadcrumbs, Button, Icon, PageHeader, StatusIndicator, Timeline } from "@vpn/ui";
import type { CaseSummary, OwnerOrderSummary, Page, SupportDetail } from "@vpn/shared";
import { supportCategory } from "@vpn/shared";
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { request } from "../../api/client";
import { date, errorMessage, label, LoadState, useOwner } from "./account";
import { PageList } from "./CommercePages";

const path = "/me/support/cases";
const categories: Record<CaseSummary["category"], string> = {
  PAYMENT: "Оплата", DELIVERY: "Выдача доступа", ACCESS: "Подключение", OTHER: "Другой вопрос",
};

function useSend() {
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function send<T>(url: string, body: object): Promise<T | undefined> {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    const fingerprint = JSON.stringify([url, body]);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const result = await request<T>(url, { method: "POST", body, idempotencyKey: intent.current.key });
      intent.current = null;
      return result;
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return { send, pending, error };
}

export function SupportPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const orderId = params.get("orderId");
  const orders = useOwner<Page<OwnerOrderSummary>>("/orders?limit=25");
  const { send, pending, error } = useSend();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const orderId = values.get("orderId") || undefined;
    const result = await send<{ case: CaseSummary }>(path, {
      category: supportCategory.parse(values.get("category")), orderId, message: String(values.get("message")).trim(),
    });
    if (result) navigate(`/account/support/${result.case.id}`);
  }
  return <><PageHeader title="Поддержка" description="Вопросы об оплате, доступе и подключении." />
    <section className="mzt-panel"><h2>Новое обращение</h2>
      <p>Если оплата подтверждена, а доступ ещё готовится, приложите номер заказа. Пароли, платёжные данные и ссылки для подключения оставьте при себе.</p>
      <form className="mzt-form" onSubmit={event => void submit(event)}>
        <label>Тема<select name="category">{Object.entries(categories).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
        <label>Заказ<select name="orderId" defaultValue={orderId ?? ""}>
          <option value="">Общий вопрос</option>
          {orderId && <option value={orderId}>Заказ {orderId.slice(0, 8)}</option>}
          {orders.data?.items.filter(order => order.id !== orderId).map(order =>
            <option key={order.id} value={order.id}>{order.snapshot.name ?? "MZT"} · {date(order.createdAt)} · {order.id.slice(0, 8)}</option>)}
        </select></label>
        {orders.isError && <LoadState pending={false} error={orders.error} retry={orders.refetch} />}
        <label>Сообщение<textarea name="message" rows={4} maxLength={2000} required /></label>
        <div className="mzt-actions"><Button type="submit" loading={pending}>Создать обращение</Button></div>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
    <h2>Мои обращения</h2>
    <PageList<CaseSummary> path={path} empty="Обращений пока нет." render={ticket => <>
      <h3><Link to={`/account/support/${ticket.id}`}>{categories[ticket.category]}</Link></h3>
      <p><StatusIndicator status={ticket.status}>{label(ticket.status)}</StatusIndicator> · {date(ticket.updatedAt)}</p>
    </>} />
  </>;
}

export function SupportThreadPage() {
  const { id } = useParams();
  // Key form and pagination state by case so back/forward can't submit the previous draft.
  return <SupportThread key={id} ticketPath={`${path}/${id}`} />;
}

function SupportThread({ ticketPath }: { ticketPath: string }) {
  const [cursor, setCursor] = useState<string>();
  const [historyCursor, setHistoryCursor] = useState<string>();
  const pagination = new URLSearchParams();
  if (cursor) pagination.set("cursor", cursor);
  if (historyCursor) pagination.set("historyCursor", historyCursor);
  const query = useOwner<SupportDetail>(ticketPath + (pagination.size ? "?" + pagination : ""));
  const [draft, setDraft] = useState("");
  const { send, pending, error } = useSend();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await send(`${ticketPath}/messages`, { message: draft.trim() });
    if (result) {
      setDraft("");
      setCursor(undefined);
      setHistoryCursor(undefined);
      if (!cursor && !historyCursor) await query.refetch();
    }
  }
  const ticket = query.data?.case;
  return <><Breadcrumbs><Link to="/account/support"><Icon name="back" size={16} />Все обращения</Link></Breadcrumbs><PageHeader title="Обращение" />
    <LoadState pending={query.isPending} error={query.error} retry={query.refetch} />
    {ticket && <section className="mzt-panel"><h2>{categories[ticket.category]}</h2>
      <p><StatusIndicator status={ticket.status}>{label(ticket.status)}</StatusIndicator> · {date(ticket.updatedAt)}</p>
      {ticket.orderId && <Link to={`/account/orders/${ticket.orderId}`}>Связанный заказ</Link>}
      <div className="mzt-messages" aria-label="Переписка"><Timeline>
        {query.data?.messages.items.slice().reverse().map(message => <li key={message.id} data-author={message.author}>
          <p><strong>{message.author === "STAFF" ? "Поддержка" : "Вы"}</strong> · {date(message.createdAt)}</p>
          <p className="mzt-message">{message.text}</p>
        </li>)}
      </Timeline></div>
      <div className="mzt-actions">
        {cursor && <button onClick={() => setCursor(undefined)}>Новые сообщения</button>}
        {query.data?.messages.nextCursor && <button onClick={() => setCursor(query.data!.messages.nextCursor!)}>Ранние сообщения</button>}
      </div>
      {ticket.status === "RESOLVED" ? <p>Обращение закрыто.</p> : <form className="mzt-form" onSubmit={event => void submit(event)}>
        <label>Ответ<textarea value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={2000} required /></label>
        <div className="mzt-actions"><Button type="submit" loading={pending}>Отправить</Button></div>
        {error && <p role="alert">{error}</p>}
      </form>}
      <details><summary>История статусов</summary>
        <ul>{query.data?.history.items.map(entry =>
          <li key={entry.id}>{label(entry.status)} · {date(entry.createdAt)}</li>)}</ul>
        <div className="mzt-actions">
          {historyCursor && <button onClick={() => setHistoryCursor(undefined)}>Последние изменения</button>}
          {query.data?.history.nextCursor && <button onClick={() => setHistoryCursor(query.data!.history.nextCursor!)}>Ранние изменения</button>}
        </div>
      </details>
    </section>}
  </>;
}
