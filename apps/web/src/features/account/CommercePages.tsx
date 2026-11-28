import { useProductConfig } from "../../config";
import { ProductLinks } from "../../components/ProductLinks";
import { Badge, Breadcrumbs, Button, Card, Dialog, EmptyState, Icon, PageHeader, Pagination, StatusIndicator,
  Timeline, buttonClass } from "@vpn/ui";
import type { Offer, OwnerOrderDetail, OwnerOrderSummary, OwnerPayment, OwnerPeriod, OwnerSubscription, Page, PaymentChannel, RenewalPreview } from "@vpn/shared";
import { useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { request } from "../../api/client";
import { ApiError } from "../../api/ApiError";
import { amount, date, displayDelivery, errorMessage, label, LoadState, useOwner } from "./account";
import { ConnectionCard } from "./ConnectionPage";

const useSubscription = () => useOwner<OwnerSubscription>("/me/subscription");
const titleOf = (value: { name: string | null }) => value.name ?? "Подписка MZT";
function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <Card className={`mzt-panel ${className}`}>{children}</Card>;
}

export function DashboardPage() {
  const overview = useSubscription();
  const orders = useOwner<Page<OwnerOrderSummary>>("/orders?limit=3");
  const sub = overview.data?.subscription;
  const period = sub?.currentPeriod;
  const latest = orders.data?.items[0];
  const pendingOrder = !sub && latest?.orderState === "OPEN" ? latest : null;
  const delivery = sub ? displayDelivery(sub) : null;
  const ready = !overview.isError && sub?.rightStatus === "ACTIVE" && delivery === "READY";
  const remaining = sub?.coverageEndsAt && overview.data
    ? Math.max(0, Math.ceil((Date.parse(sub.coverageEndsAt) - Date.parse(overview.data.serverTime)) / 86_400_000)) : null;
  const headline = ready ? "Подключение готово" : sub?.rightStatus === "HELD" ? "Доступ приостановлен"
    : sub?.rightStatus === "EXPIRED" ? "Подписка истекла" : sub?.rightStatus === "SCHEDULED" ? "Подписка запланирована"
    : delivery === "REVIEW" ? "Подключение на проверке"
    : sub?.rightStatus === "ACTIVE" ? "Готовим подключение"
    : pendingOrder?.moneyStatus === "CAPTURE_RECORDED" ? "Оплата подтверждена"
    : pendingOrder?.moneyStatus === "UNKNOWN" ? "Проверяем оплату"
    : pendingOrder?.moneyStatus === "WAITING" ? "Заказ ожидает оплаты" : "Подключите MZT";
  const detail = ready ? "Добавьте подписку в VPN-клиент, чтобы начать пользоваться доступом."
    : sub?.rightStatus === "HELD" ? "Напишите в поддержку, чтобы узнать причину приостановки."
    : sub?.rightStatus === "SCHEDULED" ? "Начало следующего периода указано в подписке."
    : sub?.rightStatus === "EXPIRED" ? "Выберите новое предложение, чтобы продлить доступ."
    : sub?.rightStatus === "ACTIVE" ? "Оплаченный период учтён. Доступ появится после подтверждения подключения."
    : pendingOrder?.moneyStatus === "CAPTURE_RECORDED" ? "Поступление учтено. Проверьте состояние начисления в деталях заказа."
    : pendingOrder?.moneyStatus === "UNKNOWN" ? "Дождитесь уточнения исхода в деталях заказа, прежде чем повторять оплату."
    : pendingOrder?.moneyStatus === "WAITING" ? "Срок и доступные действия указаны в деталях заказа."
    : "Выберите срок подписки и лимит устройств.";
  const primary = ready ? { path: "/account/connect", label: "Подключиться" }
    : sub?.rightStatus === "HELD" || delivery === "REVIEW" ? { path: "/account/support", label: "Написать в поддержку" }
    : pendingOrder ? { path: "/account/orders/" + pendingOrder.id, label: "Открыть заказ" }
    : sub?.rightStatus === "ACTIVE" || sub?.rightStatus === "SCHEDULED"
      ? { path: "/account/subscription", label: "Посмотреть подписку" }
      : { path: "/account/plans", label: sub ? "Продлить" : "Выбрать тариф" };
  return <div className="mzt-dashboard">
    <PageHeader title="Мой кабинет" description="Управление подпиской и подключениями." />
    <LoadState pending={overview.isPending} error={overview.error} retry={overview.refetch} />
    {overview.data && !overview.isError && <>
      <Card className="mzt-subscription-summary">
        <div className="mzt-subscription-summary__detail">
          <StatusIndicator status={sub?.rightStatus ?? pendingOrder?.moneyStatus ?? "EMPTY"}>{sub?.rightStatus === "ACTIVE"
            ? "Активная подписка" : sub ? label(sub.rightStatus) : pendingOrder ? label(pendingOrder.moneyStatus) : "Нет подписки"}</StatusIndicator>
          <h2>{period?.snapshot ? `${titleOf(period.snapshot)} · ${period.snapshot.durationMonths} мес.` : headline}</h2>
          <p className="mz-muted">{sub?.coverageEndsAt ? `Действует до ${date(sub.coverageEndsAt)}` : detail}</p>
        </div>
        <div className="mz-actions mzt-subscription-summary__actions">
          <Link className={buttonClass()} to={primary.path}>{primary.label}</Link>
        </div>
      </Card>
      <div className="mzt-account-facts">
        <Card className="mz-cut--stat"><Icon name="clock" size={19} /><div><h2>Осталось</h2>
          <p>{remaining === null ? "—" : `${remaining} дн.`}</p></div></Card>
        <Card className="mz-cut--stat"><Icon name="terminal" size={19} /><div><h2>Лимит устройств</h2>
          <p>{period ? `До ${period.deviceLimit}` : "—"}</p></div></Card>
        <Card className="mz-cut--stat"><Icon name="pulse" size={19} /><div><h2>Готовность профиля</h2>
          <p><StatusIndicator status={delivery ?? "EMPTY"}>{delivery ? label(delivery) : "Не запрошено"}</StatusIndicator></p></div></Card>
      </div>
      <ConnectionCard compact />
    </>}
    {!overview.isPending && !orders.isPending && <div className="mzt-account-overview-bottom">
      <Card className="mzt-overview-panel">
        <div className="mzt-panel-heading"><h2><Icon name="receipt" size={18} />Последние заказы</h2>
          <Link className="mzt-inline-link" to="/account/orders">Все заказы <Icon name="arrow" size={15} /></Link></div>
        <LoadState pending={false} error={orders.error} retry={orders.refetch} />
        {orders.data && !orders.isError && (orders.data.items.length ? <ul className="mzt-latest-orders">
          {orders.data.items.map(order => <li key={order.id}><Link to={`/account/orders/${order.id}`}>
            <span>{titleOf(order.snapshot)}<small>{date(order.createdAt)}</small></span>
            <span className="mzt-latest-orders__amount">{amount(order.snapshot.price.amountMinor, order.snapshot.price.currency)}
              <small>{label(order.moneyStatus)}</small></span>
          </Link></li>)}
        </ul> : <p className="mz-muted">Заказов пока нет.</p>)}
      </Card>
      <Card className="mzt-overview-panel">
        <div className="mzt-panel-heading"><h2><Icon name="support" size={18} />Поддержка</h2></div>
        <p className="mz-muted">Поможем с заказом или подключением.</p>
        <Link className={buttonClass("secondary")} to="/account/support">Написать в поддержку</Link>
      </Card>
    </div>}
  </div>;
}

export function PlansPage() {
  const salesClosed = useProductConfig().data?.availability.payments === false;
  const catalog = useOwner<{ offers: Offer[] }>("/plans");
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const [choice, setChoice] = useState<Offer>();
  const [section] = useSearchParams();
  const renewal = section.get("renewal") === "1";
  const estimate = useOwner<RenewalPreview>(renewal && choice
    ? "/me/subscription/renewal?" + new URLSearchParams({ offerVersionId: choice.id }) : null);
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
      if (err instanceof ApiError && ["OFFER_CHANGED", "OFFER_UNAVAILABLE"].includes(err.code)) {
        setChoice(undefined);
        await catalog.refetch();
      }
    } finally { inFlight.current = false; setPending(null); }
  }
  const basePrice = choice && catalog.data?.offers.find(offer => offer.durationMonths === 1 &&
    offer.planId === choice.planId && offer.deviceLimit === choice.deviceLimit && offer.price.currency === choice.price.currency);
  const saving = choice && basePrice ? basePrice.price.amountMinor * choice.durationMonths - choice.price.amountMinor : 0;
  return <><PageHeader title={renewal ? "Продление подписки" : "Тарифы"} description="Выберите срок подписки и количество устройств." />
    <div className="mzt-notice"><Icon name="clock" /><p>Условия заказа фиксируются на 30 минут. Доступные способы оплаты проверяются при открытии заказа.</p></div>
    <LoadState pending={catalog.isPending} error={catalog.error} retry={catalog.refetch} />
    {error && !choice && <p role="alert">{error}</p>}
    {catalog.data?.offers.length === 0 && <EmptyState title="Доступных предложений пока нет" />}
    <div className="mzt-grid mzt-catalog">{catalog.data?.offers.map(offer => <Panel className="mzt-offer" key={offer.id}>
      <header><Badge tone="accent">{offer.durationMonths} мес.</Badge><h2>{offer.name}</h2></header>
      <p className="mzt-price">{amount(offer.price.amountMinor, offer.price.currency)}</p>
      <dl className="mzt-detail"><dt>Устройства</dt><dd>До {offer.deviceLimit}</dd></dl>
      {salesClosed ? <p className="mz-muted">Покупка временно недоступна</p> :
        <Button variant="secondary" block onClick={() => { setError(""); setChoice(offer); }}>Выбрать</Button>}
    </Panel>)}</div>
    <Dialog className="mzt-checkout-dialog" open={!!choice} title="Проверьте условия" busy={pending !== null} onClose={() => setChoice(undefined)}>
      {choice && <><h3>{choice.name}</h3><dl className="mzt-detail">
        <dt>Сумма</dt><dd>{amount(choice.price.amountMinor, choice.price.currency)}</dd>
        <dt>Срок</dt><dd>{choice.durationMonths} мес.</dd>
        {choice.durationMonths > 1 && <><dt>В среднем за месяц</dt><dd>{amount(
          Math.round(choice.price.amountMinor / choice.durationMonths), choice.price.currency)}</dd></>}
        {saving > 0 && <><dt>Экономия против помесячной оплаты</dt><dd>{amount(saving, choice.price.currency)}</dd></>}
        <dt>Устройства</dt><dd>До {choice.deviceLimit}</dd>
      </dl>
        {renewal && <><LoadState pending={estimate.isPending} error={estimate.error} retry={estimate.refetch} />
          {estimate.data && !estimate.isError && <p>Предварительная дата окончания: {date(estimate.data.estimatedEndAt)}.
            Фактический срок определяется после подтверждения оплаты.</p>}</>}
        <p className="mz-muted">После создания заказ появится в истории. Сейчас списания не будет.</p>
        <ProductLinks kind="legal" />
        {salesClosed && <p role="status">Покупка временно недоступна.</p>}
        {error && <p role="alert">{error}</p>}
        <div className="mz-actions"><Button variant="secondary" disabled={!!pending} onClick={() => setChoice(undefined)}>Отмена</Button>
          <Button loading={!!pending} disabled={salesClosed || (renewal && (!estimate.data || estimate.isError))} onClick={() => void buy(choice)}>Создать заказ</Button></div></>}
    </Dialog>
  </>;
}

export function PageList<T extends { id: string }>({ path, empty, render, refetchInterval }: {
  path: string; empty: string; refetchInterval?: number; render: (item: T) => ReactNode;
}) {
  const [cursor, setCursor] = useState<string>();
  const suffix = cursor ? `?${new URLSearchParams({ cursor })}` : "";
  const query = useOwner<Page<T>>(path + suffix, refetchInterval);
  return <>
    <LoadState pending={query.isPending} error={query.error} retry={query.refetch} />
    {query.data?.items.length === 0 && <EmptyState title={empty} />}
    <div className="mzt-stack">{query.data?.items.map(item => <Panel key={item.id}>{render(item)}</Panel>)}</div>
    <Pagination onFirst={cursor ? () => setCursor(undefined) : undefined}
      onNext={query.data?.nextCursor ? () => setCursor(query.data!.nextCursor!) : undefined} />
  </>;
}

function OrderFacts({ order }: { order: OwnerOrderSummary }) {
  return <dl className="mzt-record-facts">
    <dt>Заказ</dt><dd><StatusIndicator status={order.orderState}>{label(order.orderState)}</StatusIndicator></dd>
    <dt>Оплата</dt><dd><StatusIndicator status={order.moneyStatus} tone={order.moneyStatus === "WAITING" ? "neutral" : undefined}>{label(order.moneyStatus)}</StatusIndicator></dd>
    <dt>Выдача</dt><dd><StatusIndicator status={order.deliveryStatus}>{label(order.deliveryStatus)}</StatusIndicator></dd>
    <dt>Создан</dt><dd>{date(order.createdAt)}</dd>
    <dt>Окно оплаты</dt><dd>{date(order.expiresAt)}</dd>
  </dl>;
}

export function OrdersPage() {
  return <><PageHeader title="Заказы" description="История покупок, оплаты и выдачи доступа." /><PageList<OwnerOrderSummary> path="/orders" empty="Заказов пока нет." render={order => <>
    <div className="mzt-feature-row"><h2><Link className="mzt-record-link" to={`/account/orders/${order.id}`}>{titleOf(order.snapshot)} <Icon name="arrow" size={16} /></Link></h2>
      <strong className="mzt-order-price">{amount(order.snapshot.price.amountMinor, order.snapshot.price.currency)}</strong></div><OrderFacts order={order} />
  </>} /></>;
}

export function OrderPage() {
  const { id } = useParams();
  const path = `/orders/${encodeURIComponent(id ?? "")}`;
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
  return <><Breadcrumbs><Link to="/account/orders"><Icon name="back" size={16} />Все заказы</Link></Breadcrumbs>
    <PageHeader title="Заказ" description="Условия предложения, оплата и состояние выдачи." />
    <LoadState pending={query.isPending} error={query.error} retry={query.refetch} />
    {order && <>
      <Panel><div className="mzt-feature-row"><div><h2>{titleOf(order.snapshot)}</h2><p className="mz-muted">{order.snapshot.durationMonths} мес. · до {order.snapshot.deviceLimit} устройств</p></div>
        <p className="mzt-price">{amount(order.snapshot.price.amountMinor, order.snapshot.price.currency)}</p></div>
        <OrderFacts order={order} />
        <div className="mz-actions"><Link className={buttonClass("secondary")} to={`/account/support?orderId=${order.id}`}><Icon name="support" size={17} />Помощь с заказом</Link></div>
        {order.allowedChannels.length === 0 && <div className="mzt-notice"><Icon name="clock" size={18} /><p>Оплата сейчас недоступна.</p></div>}
        {order.canStartPayment && order.allowedChannels.map(channel =>
          <Button key={channel} disabled={pending} onClick={() => void startPayment(channel)}>{channel === "SBP" ? "СБП" : "Карта"}</Button>)}
        {error && <p role="alert">{error}</p>}
        {order.refunds.map(refund => <p key={refund.id}>Возврат {amount(refund.amountMinor, refund.currency)} · {date(refund.confirmedAt)}</p>)}
      </Panel>
      <h2 className="mzt-section-title"><Icon name="receipt" size={19} />Попытки оплаты</h2>
      <PageList<OwnerPayment> key={order.id} path={path + "/payments"} empty="Платёжных попыток пока нет." render={attempt => <>
        <p><StatusIndicator status={attempt.status} tone={["CREATED", "SUBMITTING", "AWAITING_CUSTOMER", "PROCESSING"].includes(attempt.status) ? "neutral" : undefined}>{label(attempt.status)}</StatusIndicator> · {date(attempt.updatedAt)}</p>
        {attempt.confirmedCaptures.map(fact => <p key={fact.id}>Поступление {amount(fact.amountMinor, fact.currency)} · {date(fact.confirmedAt)}</p>)}
      </>} />
    </>}
  </>;
}

export function SubscriptionPage() {
  const overview = useSubscription();
  const sub = overview.data?.subscription;
  const delivery = sub ? displayDelivery(sub) : null;
  return <><PageHeader title="Подписка" description="Текущее право, состояние подключения и история периодов." />
    <LoadState pending={overview.isPending} error={overview.error} retry={overview.refetch} />
    {overview.data && !sub && <EmptyState title="Доступ ещё не подключён">
      <Link className={buttonClass("secondary")} to="/account/plans">Посмотреть тарифы</Link>
    </EmptyState>}
    {sub && delivery && <Panel className="mzt-subscription-detail"><div className="mzt-feature-row">
      <h2 className="mzt-section-title"><Icon name="layers" size={20} />Состояние подписки</h2><Link className={buttonClass()} to="/account/plans">Продлить</Link></div>
      <dl className="mzt-record-facts">
        <dt>Оплаченное право</dt><dd><StatusIndicator status={sub.rightStatus}>{label(sub.rightStatus)}</StatusIndicator></dd>
        <dt>Выдача</dt><dd><StatusIndicator status={delivery}>{label(delivery)}</StatusIndicator></dd>
        <dt>Проверено панелью</dt><dd>{date(sub.delivery.observedAt)}</dd>
        <dt>Доступ до</dt><dd>{date(sub.coverageEndsAt)}</dd>
        <dt>Следующее изменение</dt><dd>{date(sub.nextBoundaryAt)}</dd>
      </dl></Panel>}
    <h2 className="mzt-section-title"><Icon name="clock" size={19} />Периоды доступа</h2>
    <PageList<OwnerPeriod> path="/me/subscription/periods" empty="Оплаченных периодов пока нет." render={period => <>
      <Timeline><li><h3>{period.snapshot ? titleOf(period.snapshot) : "Компенсация"} · {period.deviceLimit} устройств</h3>
      <p>{date(period.startAt)} — {date(period.endAt)}</p>
      {period.adjustments.map(item => <p key={item.id}>Корректировка права с {date(item.effectiveAt)}</p>)}
      {period.orderId && <Link className="mzt-record-link" to={`/account/orders/${period.orderId}`}>Заказ периода <Icon name="arrow" size={16} /></Link>}</li></Timeline>
    </>} />
  </>;
}
