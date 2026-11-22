import type { Offer, OwnerOrderDetail, OwnerOrderSummary, OwnerPayment, OwnerPeriod, OwnerSubscription, Page, PaymentChannel } from "@vpn/shared";
import { useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { request } from "../../api/client";
import { ApiError } from "../../api/ApiError";
import { amount, date, errorMessage, label, LoadState, useOwner } from "./account";

const useSubscription = () => useOwner<OwnerSubscription>("/me/subscription");
const titleOf = (value: { name: string | null }) => value.name ?? "Подписка MZT";
function Panel({ children }: { children: ReactNode }) { return <section className="mzt-panel">{children}</section>; }

export function DashboardPage() {
  const overview = useSubscription();
  const sub = overview.data?.subscription;
  const period = sub?.currentPeriod;
  const remaining = sub?.coverageEndsAt && overview.data
    ? Math.max(0, Math.ceil((Date.parse(sub.coverageEndsAt) - Date.parse(overview.data.serverTime)) / 86_400_000)) : null;
  return <><h1>Обзор</h1><LoadState pending={overview.isPending} error={overview.error} retry={overview.refetch} />
    {overview.data && <Panel>
      <h2>{period?.snapshot ? titleOf(period.snapshot) : "Подписка"}</h2>
      <p>{sub ? label(sub.rightStatus) : "Оплаченных периодов пока нет."}</p>
      {sub && <dl className="mzt-detail">
        <dt>Выдача</dt><dd>{label(sub.delivery.status)}</dd>
        <dt>Доступ до</dt><dd>{date(sub.coverageEndsAt)}{remaining !== null && ` · до ${remaining} дн.`}</dd>
        <dt>Лимит устройств</dt><dd>{period?.deviceLimit ?? "—"}</dd>
      </dl>}
      {sub?.delivery.status === "WAITING" && <p>Право учтено. Панель ещё не подтвердила профиль.</p>}
      <div className="mzt-actions"><Link to="/account/plans">{sub ? "Продлить" : "Выбрать тариф"}</Link>
        {sub?.delivery.status === "READY" && <Link to="/account/connect">Подключиться</Link>}</div>
    </Panel>}
  </>;
}

export function PlansPage() {
  const catalog = useOwner<{ offers: Offer[] }>("/plans");
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  async function buy(offer: Offer) {
    if (inFlight.current) return;
    inFlight.current = true;
    const key = keys.current.get(offer.id) ?? crypto.randomUUID();
    keys.current.set(offer.id, key);
    setPending(offer.id); setError("");
    try {
      const order = await request<{ orderId: string }>("/orders", {
        method: "POST", body: { offerVersionId: offer.id }, idempotencyKey: key,
      });
      navigate(`/account/orders/${order.orderId}`);
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && ["OFFER_CHANGED", "OFFER_UNAVAILABLE"].includes(err.code)) await catalog.refetch();
    } finally { inFlight.current = false; setPending(null); }
  }
  return <><h1>Тарифы</h1>
    <p>Заказ фиксирует условия на 30 минут. Оплата появится после подключения платёжного канала.</p>
    <LoadState pending={catalog.isPending} error={catalog.error} retry={catalog.refetch} />
    {error && <p role="alert">{error}</p>}
    {catalog.data?.offers.length === 0 && <p>Доступных предложений пока нет.</p>}
    <div className="mzt-grid">{catalog.data?.offers.map(offer => <Panel key={offer.id}>
      <h2>{offer.name}</h2><p className="mzt-price">{amount(offer.price.amountMinor, offer.price.currency)}</p>
      <p>{offer.durationMonths} мес. · {offer.deviceLimit} устройств</p>
      <button disabled={pending !== null} onClick={() => void buy(offer)}>{pending === offer.id ? "Создаём…" : "Создать заказ"}</button>
    </Panel>)}</div>
  </>;
}

export function PageList<T extends { id: string }>({ path, empty, render }: {
  path: string; empty: string; render: (item: T) => ReactNode;
}) {
  const [cursor, setCursor] = useState<string>();
  const suffix = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  const query = useOwner<Page<T>>(path + suffix);
  return <>
    <LoadState pending={query.isPending} error={query.error} retry={query.refetch} />
    {query.data?.items.length === 0 && <p>{empty}</p>}
    <div className="mzt-stack">{query.data?.items.map(item => <Panel key={item.id}>{render(item)}</Panel>)}</div>
    <div className="mzt-actions">
      {cursor && <button onClick={() => setCursor(undefined)}>К началу</button>}
      {query.data?.nextCursor && <button onClick={() => setCursor(query.data!.nextCursor!)}>Следующая страница</button>}
    </div>
  </>;
}

function OrderFacts({ order }: { order: OwnerOrderSummary }) {
  return <dl className="mzt-detail">
    <dt>Заказ</dt><dd>{label(order.orderState)}</dd>
    <dt>Оплата</dt><dd>{label(order.moneyStatus)}</dd>
    <dt>Выдача</dt><dd>{label(order.deliveryStatus)}</dd>
    <dt>Создан</dt><dd>{date(order.createdAt)}</dd>
    <dt>Окно оплаты</dt><dd>{date(order.expiresAt)}</dd>
  </dl>;
}

export function OrdersPage() {
  return <><h1>Заказы</h1><PageList<OwnerOrderSummary> path="/orders" empty="Заказов пока нет." render={order => <>
    <h2><Link to={`/account/orders/${order.id}`}>{titleOf(order.snapshot)}</Link></h2>
    <p>{amount(order.snapshot.price.amountMinor, order.snapshot.price.currency)}</p><OrderFacts order={order} />
  </>} /></>;
}

export function OrderPage() {
  const { id } = useParams();
  const path = `/orders/${id}`;
  const query = useOwner<OwnerOrderDetail>(path);
  const order = query.data;
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const key = useRef(new Map<string, string>());
  async function startPayment(channel: PaymentChannel) {
    const idempotencyKey = key.current.get(channel) ?? crypto.randomUUID();
    key.current.set(channel, idempotencyKey);
    setPending(true); setError("");
    try {
      const result = await request<{ nextAction: { type: "WAIT" } | { type: "REDIRECT"; url: string } }>(path + "/payments", {
        method: "POST", body: { channel }, idempotencyKey,
      });
      if (result.nextAction.type === "REDIRECT") window.location.assign(result.nextAction.url);
      else await query.refetch();
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  }
  return <><Link to="/account/orders">Все заказы</Link><h1>Заказ</h1>
    <LoadState pending={query.isPending} error={query.error} retry={query.refetch} />
    {order && <>
      <Panel><h2>{titleOf(order.snapshot)}</h2><p>{amount(order.snapshot.price.amountMinor, order.snapshot.price.currency)} · {order.snapshot.durationMonths} мес.</p>
        <OrderFacts order={order} />
        <Link to={`/account/support?orderId=${order.id}`}>Помощь с заказом</Link>
        {order.allowedChannels.length === 0 && <p>Оплата сейчас недоступна.</p>}
        {order.canStartPayment && order.allowedChannels.map(channel =>
          <button key={channel} disabled={pending} onClick={() => void startPayment(channel)}>{channel === "SBP" ? "СБП" : "Карта"}</button>)}
        {error && <p role="alert">{error}</p>}
        {order.refunds.map(refund => <p key={refund.id}>Возврат {amount(refund.amountMinor, refund.currency)} · {date(refund.confirmedAt)}</p>)}
      </Panel>
      <h2>Попытки оплаты</h2>
      <PageList<OwnerPayment> key={order.id} path={path + "/payments"} empty="Платёжных попыток пока нет." render={attempt => <>
        <p>{label(attempt.status)} · {date(attempt.updatedAt)}</p>
        {attempt.confirmedCaptures.map(fact => <p key={fact.id}>Поступление {amount(fact.amountMinor, fact.currency)} · {date(fact.confirmedAt)}</p>)}
      </>} />
    </>}
  </>;
}

export function SubscriptionPage() {
  const overview = useSubscription();
  return <><h1>Подписка</h1>
    <LoadState pending={overview.isPending} error={overview.error} retry={overview.refetch} />
    {overview.data?.subscription && <Panel><p>{label(overview.data.subscription.rightStatus)}</p>
      <p>Непрерывное право до {date(overview.data.subscription.coverageEndsAt)}</p>
      <p>Следующая граница {date(overview.data.subscription.nextBoundaryAt)}</p></Panel>}
    <h2>Периоды доступа</h2>
    <PageList<OwnerPeriod> path="/me/subscription/periods" empty="Оплаченных периодов пока нет." render={period => <>
      <h3>{period.snapshot ? titleOf(period.snapshot) : "Компенсация"} · {period.deviceLimit} устройств</h3>
      <p>{date(period.startAt)} — {date(period.endAt)}</p>
      {period.adjustments.map(item => <p key={item.id}>Корректировка права с {date(item.effectiveAt)}</p>)}
      {period.orderId && <Link to={`/account/orders/${period.orderId}`}>Заказ периода</Link>}
    </>} />
  </>;
}
