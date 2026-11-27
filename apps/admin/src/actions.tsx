import { Link } from "react-router";
import { Action } from "./commands";
import { useCan, useSession } from "./session";
import { Facts, RequestState, Table, useAdmin, type Page, type Row } from "./views";

export function PlanCreate() {
  return <Action title="Создать тариф" operation="plan.create" permission="plans:write" version={0}
    target={body => String(body.code)} fields={[
      { name: "code", label: "Код" }, { name: "name", label: "Название" },
      { name: "deviceLimit", label: "Лимит устройств", type: "number", value: 5 },
    ]} />;
}
export function PlanActions({ plan, versions }: { plan: Row; versions: Row[] }) {
  const version = String(plan.revision);
  return <>
    {plan.isActive ? <Action title="Опубликовать предложение" operation="plan.publish" permission="plans:write" target={plan.id} version={version}
      baseline={body => {
        const offer = versions.find(row => !row.withdrawnAt && row.currency === body.currency && Number(row.durationMonths) === Number(body.durationMonths));
        return offer && { name: offer.name, durationMonths: offer.durationMonths, amountMinor: offer.amount, currency: offer.currency, deviceLimit: offer.deviceLimit };
      }}
      fields={[{ name: "name", label: "Название", value: String(plan.name) },
        { name: "durationMonths", label: "Месяцы", type: "number", value: 1 },
        { name: "currency", label: "Валюта", options: ["RUB", "USD", "XTR"] },
        { name: "amountMinor", label: "Сумма в минимальных единицах", type: "number" },
        { name: "deviceLimit", label: "Лимит устройств", type: "number", value: Number(plan.deviceLimit) }]} />
      : <Action title="Активировать тариф для новых публикаций" operation="plan.update" permission="plans:write"
        target={plan.id} version={version} payload={{ isActive: true }} />}
    {versions.filter(row => !row.withdrawnAt).map(row => <Action key={row.id} title={`Снять предложение · ${row.currency} · ${row.durationMonths} мес.`}
      operation="plan.retire_offer" permission="plans:write" target={plan.id} version={version} payload={{ offerId: row.id }} />)}
    {Boolean(plan.isActive) && <Action title="Снять все предложения тарифа" operation="plan.retire" permission="plans:write" target={plan.id} version={version} />}
  </>;
}
export function AccessActions({ row }: { row: Row }) {
  const subscription = row.subscription as { id: string; revision: number; binding: { blockedReason?: string } | null; holds: Row[] } | null;
  const revision = subscription?.revision ?? 0;
  return <>
    {row.activation === "PENDING" && row.status === "ACTIVE" && <Action title="Активировать аккаунт вручную"
      operation="user.activate" permission="users:write" target={row.id} version={String(row.version)}
      context={String(row.email ?? row.id)} />}
    <Action title={row.status === "BLOCKED" ? "Восстановить вход" : "Заблокировать вход"} operation="user.account_status"
      permission="users:write" target={row.id} version={String(row.version)} payload={{ status: row.status === "BLOCKED" ? "ACTIVE" : "BLOCKED" }} />
    <Action title="Удержать VPN-доступ" operation="user.hold" permission="access:write" target={row.id} version={revision}
      fields={[{ name: "kind", label: "Основание", options: ["ADMIN", "FRAUD", "SERVICE_CONFLICT"] }]} />
    {subscription?.holds.filter(hold => !hold.releasedAt && String(hold.source ?? "").startsWith("staff:")).map(hold =>
      <Action key={hold.id} title={"Снять удержание · " + hold.id.slice(0, 8)} operation="user.release_hold"
        permission="access:write" target={row.id} version={revision} payload={{ holdId: hold.id }} />)}
    {Boolean(revision) && <Action title="Сверить актуальное назначение" operation="user.reconcile_access" permission="jobs:write"
      target={row.id} version={revision} />}
    {subscription?.binding?.blockedReason && <Action title="Подтвердить сохранение запрета" operation="user.binding_review"
      permission="bindings:write" target={row.id} version={revision} payload={{ decision: "KEEP_HOLD" }}
      fields={[{ name: "reviewId", label: "ID операторского дела" }]} />}
    {Boolean(revision) && <Action title="Компенсировать время инцидента" operation="subscription.compensate"
      permission="subscription:adjust" target={row.id} version={revision} fields={[
        { name: "incidentId", label: "ID инцидента" }, { name: "affectedPeriodId", label: "ID затронутого периода" },
        { name: "durationSeconds", type: "number", label: "Длительность в секундах" },
      ]} />}
  </>;
}

export function OrderActions({ row }: { row: Row }) {
  const canFinance = useCan("finance:read");
  return <>
    <Action title="Открыть дело и запросить сверку оплаты" operation="order.reconcile" permission="finance:reconcile"
      target={row.id} version={String(row.version)} fields={[{ name: "attemptId", label: "ID попытки (необязательно)", required: false }]} />
    {canFinance && <Refunds row={row} />}
  </>;
}
function Refunds({ row }: { row: Row }) {
  const query = useAdmin<Page>(`/orders/${row.id}/refunds`);
  const actor = useSession()!.user.id;
  const version = String(row.version);
  return <section className="mz-card panel"><h2>Намерения возврата</h2>
    <p>Одобрение резервирует сумму. Исполнение провайдером закрыто до приёмки интеграции.</p>
    <RequestState state={query} />
    {query.data && <Table rows={query.data.items} columns={["id", "status", "amountMinor", "currency", "expiresAt"]} />}
    {query.data?.items.filter(refund => refund.status === "AWAITING_APPROVAL" && refund.initiatorId !== actor).map(refund =>
      <Action key={refund.id} title={"Одобрить возврат · " + refund.id.slice(0, 8)} operation="refund.approve"
        permission="finance:refund" target={row.id} version={version} payload={{ refundId: refund.id }} />)}
    <Action title="Зарезервировать возврат" operation="refund.request" permission="finance:refund" target={row.id} version={version}
      fields={[{ name: "captureId", label: "ID подтверждённого поступления" }, { name: "amountMinor", label: "Сумма в минимальных единицах" },
        { name: "currency", label: "Валюта", options: ["RUB", "USD", "XTR"] }]} />
  </section>;
}
export function Invite() {
  return <Action title="Пригласить сотрудника" operation="staff.invite" permission="staff:write" version={0}
    target={body => String(body.email).toLowerCase()} fields={[{ name: "email", label: "Служебная почта", type: "email" },
      { name: "role", label: "Роль", options: ["SUPPORT", "ADMIN"] }]} />;
}
export function StaffCreate() {
  return <Action title="Создать сотрудника" operation="staff.create" permission="staff:write" target="new" version={0}
    fields={[
      { name: "username", label: "Имя пользователя" }, { name: "displayName", label: "Отображаемое имя", required: false },
      { name: "contactEmail", label: "Контактная почта", type: "email", required: false },
      { name: "role", label: "Роль", options: ["SUPPORT", "ADMIN", "OWNER"] },
      { name: "temporaryPassword", label: "Временный пароль (действует 24 часа)", type: "password" },
    ]} />;
}
export function UserCreate() {
  return <Action title="Создать заявку клиента" operation="user.create" permission="users:create" target="new" version={0}
    fields={[{ name: "email", label: "Электронная почта", type: "email" }]} />;
}
export function CustomerCredentials({ row }: { row: Row }) {
  const allowed = useCan("users:write");
  const access = row.access as { hasPassword: boolean; mailAvailable: boolean; emailResetEligible: boolean } | undefined;
  if (!allowed || !access) return null;
  const providers = (row.identities as { provider: string }[] | undefined) ?? [];
  const methods = [
    ...(access.hasPassword ? ["Email и пароль"] : []),
    ...(providers.some(credential => credential.provider === "TELEGRAM") ? ["Telegram"] : []),
    ...(providers.some(credential => credential.provider === "GOOGLE") ? ["Google"] : []),
  ];
  const target = { target: row.id, context: String(row.email ?? row.id), version: String(row.version), permission: "users:write" };
  return <section className="mz-card panel">
    <h2>Управление доступом</h2>
    <p>Способы входа: {methods.join(", ") || "нет подключённых способов"}.</p>
    {access.hasPassword ? <>
      <p>Установка нового пароля завершит все сессии клиента и отменит прежние ссылки сброса.</p>
      <Action {...target} title="Установить новый пароль" operation="user.password.set"
        fields={[{ name: "password", label: "Новый постоянный пароль", type: "password" }]} />
      {access.mailAvailable && access.emailResetEligible
        ? <Action {...target} title="Отправить письмо для сброса пароля" operation="user.password.send_reset" />
        : <p>{!access.mailAvailable ? "Письмо для сброса недоступно: почтовая отправка отключена."
          : "Для отправки письма нужен подтверждённый email и доступный вход в аккаунт."}</p>}
    </> : <p>У клиента нет пароля. Вход и восстановление выполняются через привязанный способ входа.</p>}
  </section>;
}
export function StaffActions({ row }: { row: Row }) {
  const version = String(row.version);
  const current = useSession()!.user.id;
  const context = String(row.username ?? row.id);
  const identity = { permission: "staff:write", target: row.id, version, context };
  const mutable = row.version !== null && row.status !== "DEACTIVATED";
  return <>
    {mutable && <Action {...identity} title="Изменить профиль сотрудника и завершить сессии" operation="staff.profile"
      fields={[
        { name: "username", label: "Имя пользователя", value: context },
        { name: "displayName", label: "Отображаемое имя", value: String(row.displayName ?? ""), required: false, clearable: true },
        { name: "contactEmail", label: "Контактная почта", type: "email", value: String(row.email ?? ""), required: false, clearable: true },
      ]} />}
    {row.id !== current && mutable && <>
      <Action {...identity} title="Изменить роль и завершить сессии" operation="staff.role"
        fields={[{ name: "role", label: "Роль", options: ["SUPPORT", "ADMIN", "OWNER"], value: String(row.role) }]} />
      <Action {...identity} title={row.status === "BLOCKED" ? "Разблокировать сотрудника" : "Заблокировать сотрудника и завершить сессии"}
        operation="staff.status" payload={{ status: row.status === "BLOCKED" ? "ACTIVE" : "BLOCKED" }} />
      <Action {...identity} title="Деактивировать сотрудника и завершить сессии" operation="staff.status" payload={{ status: "DEACTIVATED" }} />
      <Action {...identity} title="Назначить временный пароль и завершить сессии" operation="staff.password.reset"
        fields={[{ name: "temporaryPassword", label: "Временный пароль (действует 24 часа)", type: "password" }]} />
      <Action {...identity} title="Сбросить TOTP и завершить сессии" operation="staff.totp.reset" />
      <Action {...identity} title="Запросить сброс TOTP с вторым подтверждением" operation="staff.totp.request"
        fields={[{ name: "recoveryCaseId", label: "ID подтверждённого дела восстановления" }]} />
      <Action {...identity} title="Завершить все сессии сотрудника" operation="staff.sessions.revoke" />
    </>}
    <div className="actions"><Link to={`/staff/${row.id}/sessions`}>Сессии сотрудника</Link>
      <Link to={`/audit?entityId=${row.id}`}>История действий</Link></div>
    {(row.resets as Row[] | undefined)?.filter(reset => !reset.approvedBy && reset.actorId !== current && row.id !== current).map(reset =>
      <Action key={reset.id} {...identity} title={"Одобрить сброс TOTP · " + reset.id.slice(0, 8)} operation="staff.totp.approve"
        payload={{ requestId: reset.id }} />)}
  </>;
}
export function Settings() {
  const allowed = useCan("settings:write");
  return allowed ? <SettingsDetail /> : null;
}
function SettingsDetail() {
  const query = useAdmin<Row>("/operations/settings");
  return <><h2>Пороги предупреждений</h2><RequestState state={query} />
    {query.data && <><Facts data={query.data} />
      <Action title="Изменить пороги" operation="settings.update" permission="settings:write" target="default" version={String(query.data.version)}
        fields={[{ name: "fulfillmentLagWarnSeconds", label: "Задержка выдачи (сек)", type: "number", value: Number(query.data.fulfillmentLagWarnSeconds) },
          { name: "paymentLagWarnSeconds", label: "Задержка платежа (сек)", type: "number", value: Number(query.data.paymentLagWarnSeconds) }]} />
    </>}
  </>;
}
