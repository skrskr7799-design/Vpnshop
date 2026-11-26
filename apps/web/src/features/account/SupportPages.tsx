import { Badge, Breadcrumbs, Button, ConfirmDialog, Icon, PageHeader, StatusIndicator, Timeline } from "@vpn/ui";
import type { CaseSummary, OwnerOrderSummary, Page, SupportDetail } from "@vpn/shared";
import { supportCategory } from "@vpn/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { request } from "../../api/client";
import { date, errorMessage, label, LoadState, useOwner } from "./account";
import { PageList } from "./CommercePages";

const path = "/me/support/cases";
const categories: Record<CaseSummary["category"], string> = {
  PAYMENT: "Оплата", DELIVERY: "Выдача доступа", ACCESS: "Подключение", OTHER: "Другой вопрос",
  GENERAL: "Общий вопрос", SUBSCRIPTION: "Подписка", TECHNICAL: "Техническая проблема", ACCOUNT: "Аккаунт",
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
      category: supportCategory.parse(values.get("category")), subject: String(values.get("subject")).trim(), orderId, message: String(values.get("message")).trim(),
    });
    if (result) navigate(`/account/support/${result.case.id}`);
  }
  return <><PageHeader title="Поддержка" description="Вопросы об оплате, доступе и подключении." />
    <div className="mzt-help-grid"><section className="mz-card mzt-panel"><h2 className="mzt-section-title"><Icon name="support" size={20} />Новое обращение</h2>
      <p>Если оплата подтверждена, а доступ ещё готовится, приложите номер заказа. Пароли, платёжные данные и ссылки для подключения оставьте при себе.</p>
      <form className="mzt-form" onSubmit={event => void submit(event)}>
        <label>Тема<input name="subject" maxLength={120} required /></label>
        <label>Категория<select name="category">{Object.entries(categories).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
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
    <section className="mzt-help-list"><h2 className="mzt-section-title"><Icon name="receipt" size={19} />Мои обращения</h2>
    <PageList<CaseSummary> path={path} refetchInterval={30_000} empty="Обращений пока нет." render={ticket => <>
      <h3><Link className="mzt-record-link" to={`/account/support/${ticket.id}`}>{ticket.subject || categories[ticket.category]} <Icon name="arrow" size={16} /></Link></h3>
      <p><StatusIndicator status={ticket.status}>{label(ticket.status)}</StatusIndicator> · {categories[ticket.category]} · {date(ticket.updatedAt)}</p>
      <p>№ {ticket.id.slice(0, 8)} {!!ticket.unread && <Badge tone="accent">Новые события · {ticket.unread}</Badge>}</p>
    </>} /></section></div>
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
  const cache = useQueryClient();
  const query = useOwner<SupportDetail>(ticketPath + (pagination.size ? "?" + pagination : ""), 30_000);
  const through = query.data?.readThrough;
  const unread = query.data?.case.unread;
  useEffect(() => {
    if (!through || !unread) return;
    void request(`${ticketPath}/read`, { method: "POST", body: { through } })
      .then(() => cache.invalidateQueries({ predicate: entry => entry.queryKey.at(-1) === path })).catch(() => {});
  }, [cache, through, ticketPath, unread, query.dataUpdatedAt]);
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
  const [confirmClose, setConfirmClose] = useState(false);
  async function transition(action: "close" | "reopen") {
    const result = await send(`${ticketPath}/status`, { action });
    if (!result) return;
    setConfirmClose(false);
    await query.refetch();
  }
  return <><Breadcrumbs><Link to="/account/support"><Icon name="back" size={16} />Все обращения</Link></Breadcrumbs><PageHeader title="Обращение" />
    <LoadState pending={query.isPending} error={query.error} retry={query.refetch} />
    {ticket && <section className="mz-card mzt-panel"><h2 className="mzt-message">{ticket.subject || categories[ticket.category]}</h2>
      <p><StatusIndicator status={ticket.status}>{label(ticket.status)}</StatusIndicator> · {categories[ticket.category]} · № {ticket.id.slice(0, 8)} · {date(ticket.updatedAt)}</p>
      {ticket.orderId && <Link className="mzt-record-link" to={`/account/orders/${ticket.orderId}`}>Связанный заказ <Icon name="arrow" size={16} /></Link>}
      <div className="mzt-messages" aria-label="Переписка"><Timeline>
        {query.data?.messages.items.slice().reverse().map(message => <li key={message.id} data-author={message.author}>
          <p><strong>{message.author === "STAFF" ? "Поддержка" : "Вы"}</strong> · {date(message.createdAt)}</p>
          <p className="mzt-message">{message.text}</p>
        </li>)}
      </Timeline></div>
      <div className="mzt-actions">
        {cursor && <Button variant="secondary" onClick={() => setCursor(undefined)}>Новые сообщения</Button>}
        {query.data?.messages.nextCursor && <Button variant="secondary" onClick={() => setCursor(query.data!.messages.nextCursor!)}>Ранние сообщения</Button>}
      </div>
      {ticket.status === "CLOSED" ? <p>Обращение закрыто.</p> : ticket.status === "RESOLVED" ? <p>Поддержка отметила обращение решённым. Его можно открыть снова.</p> : <form className="mzt-form" onSubmit={event => void submit(event)}>
        <label>Ответ<textarea value={draft} onChange={event => setDraft(event.target.value)} rows={3} maxLength={2000} required /></label>
        <div className="mzt-actions"><Button type="submit" loading={pending}>Отправить</Button></div>
      </form>}
      {error && !confirmClose && <p role="alert">{error}</p>}
      {ticket.status !== "CLOSED" && <div className="mzt-actions">
        {ticket.status === "RESOLVED" && <Button variant="secondary" loading={pending} onClick={() => void transition("reopen")}>Открыть снова</Button>}
        <Button variant="secondary" disabled={pending} onClick={() => setConfirmClose(true)}>Закрыть обращение</Button>
      </div>}
      <ConfirmDialog open={confirmClose} title="Закрыть обращение" confirmLabel="Закрыть" busy={pending}
        onClose={() => setConfirmClose(false)} onConfirm={() => void transition("close")}>
        <p>Обращение № {ticket.id.slice(0, 8)} будет закрыто. Переписка останется в истории.</p>
        {error && <p role="alert">{error}</p>}
      </ConfirmDialog>
      <details className="mzt-disclosure"><summary>История статусов</summary>
        <ul>{query.data?.history.items.map(entry =>
          <li key={entry.id}>{label(entry.status)} · {date(entry.createdAt)}</li>)}</ul>
        <div className="mzt-actions">
          {historyCursor && <Button variant="secondary" onClick={() => setHistoryCursor(undefined)}>Последние изменения</Button>}
          {query.data?.history.nextCursor && <Button variant="secondary" onClick={() => setHistoryCursor(query.data!.history.nextCursor!)}>Ранние изменения</Button>}
        </div>
      </details>
    </section>}
  </>;
}
