import { Badge, BrandMark, Button, CodeDisplay, Drawer, EmptyState, Icon, IconButton, Input, LabyrinthBackground, MobileNavigation, PageHeader, SignatureScene, StatusIndicator, Timeline, buttonClass, type IconName } from "@vpn/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { Action } from "./commands";
import { AccessActions, Invite, OrderActions, PlanActions, PlanCreate, Settings, StaffActions, StaffCreate, UserCreate } from "./actions";
import { api, ApiError, errorText } from "./api";
import { Session, useCan, useSession, type Principal } from "./session";
import { Dashboard, Detail, Facts, jobColumns, jobFilters, List, orderColumns, orderFilters, PlanDetail,
  RequestState, SupportDetail, ticketColumns, ticketFilters, states, useAdmin, valueText, type Row } from "./views";

const groups: { title: string; links: [path: string, title: string, permission: string, icon: IconName][] }[] = [
  { title: "Рабочая область", links: [["/", "Обзор", "dashboard:read", "grid"], ["/users", "Пользователи", "users:read", "users"],
    ["/orders", "Заказы", "orders:read", "receipt"], ["/payments", "Финансы", "finance:read", "money"],
    ["/subscriptions", "Подписки", "users:read", "layers"], ["/jobs", "Выдача", "jobs:read", "connect"],
    ["/plans", "Тарифы", "plans:read", "layers"], ["/support", "Поддержка", "support:read", "support"]] },
  { title: "Управление", links: [["/audit", "Аудит", "audit:read", "receipt"], ["/staff", "Сотрудники", "staff:read", "users"],
    ["/operations", "Сервисы", "ops:read", "pulse"], ["/security", "Сессии", "", "key"]] },
];

function Guard() {
  const me = useQuery({
    queryKey: ["admin-me"], queryFn: async ({ signal }) => {
      try { return await api<Principal>("/me", { signal }); }
      catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
    }, retry: false, refetchInterval: 30_000,
  });
  if (me.isPending || me.isError) return <SignatureScene brand={<BrandMark />}>
    <div className="admin-signin"><h1>Администрирование</h1><RequestState state={me} /></div>
  </SignatureScene>;
  return me.data ? <Session.Provider value={me.data}><Shell key={me.data.user.id} /></Session.Provider> : <Navigate to="/login" replace />;
}

function Shell() {
  const session = useSession()!;
  const cache = useQueryClient();
  const navigate = useNavigate();
  const [hidden, hide] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const visibleGroups = groups.map(group => ({ ...group, links: group.links.filter(([, , perm]) => !perm || session.permissions.includes(perm)) }));
  const visibleLinks = visibleGroups.flatMap(group => group.links);
  const quickLinks = ["/", "/users", "/operations"].flatMap(path => visibleLinks.filter(link => link[0] === path));
  const active = visibleLinks.find(([path]) => path !== "/" && location.pathname.startsWith(path))?.[1] ?? "Обзор";
  useEffect(() => {
    main.current?.focus({ preventScroll: true });
    document.title = active + " — MZT";
  }, [active, location.pathname]);
  async function logout() {
    hide(true); setError("");
    await cache.cancelQueries({ queryKey: ["admin"] });
    cache.removeQueries({ queryKey: ["admin"] });
    try {
      await api("/auth/logout", { method: "POST" });
      cache.setQueryData(["admin-me"], null);
      navigate("/login", { replace: true });
    } catch { setError("Данные скрыты. Серверный выход пока не подтверждён."); }
  }
  const navigation = (close?: () => void) => <nav className="admin-nav" aria-label="Разделы администрирования">
    {visibleGroups.filter(group => group.links.length).map(group => <section key={group.title}>
      <p>{group.title}</p>
      {group.links.map(([path, title, , icon]) => <NavLink end={path === "/"} key={path} to={path} className="mz-nav-link" onClick={close}>
        <Icon name={icon} size={17} />{title}</NavLink>)}
    </section>)}
  </nav>;
  return hidden ? <SignatureScene brand={<BrandMark />}>
    <div className="admin-signin"><h1>Выход из панели</h1><p role="status">{error || "Выходим…"}</p>
      {error && <Button variant="secondary" onClick={() => void logout()}>Повторить выход</Button>}</div>
  </SignatureScene> : <div className={`shell${location.pathname === "/" ? " shell--overview" : ""}`}>
    <LabyrinthBackground />
    <a className="skip" href="#main">Перейти к содержимому</a>
    <aside className="sidebar"><div className="admin-brand"><Link to="/" className="mz-brand-home"><BrandMark /></Link><span>Администрирование</span></div>{navigation()}</aside>
    <div className="body"><header className="admin-topbar">
      <div className="admin-topbar__mobile"><IconButton icon="menu" label="Открыть меню" aria-expanded={menu} onClick={() => setMenu(true)} />
        <Link to="/" className="mz-brand-home"><BrandMark /></Link></div>
      <span className="admin-topbar__context">{active}</span>
      <div className="admin-topbar__identity"><span className="admin-topbar__email">{session.user.username ?? session.user.email}</span>
        <Badge tone="accent">{session.user.role}</Badge>
        <Button variant="quiet" onClick={() => void logout()}><Icon name="out" size={16} />Выйти</Button></div>
    </header>
      <Drawer open={menu} title="Администрирование" onClose={() => setMenu(false)}>{navigation(() => {
        setMenu(false);
        requestAnimationFrame(() => main.current?.focus({ preventScroll: true }));
      })}</Drawer>
      <main id="main" className="admin-main" ref={main} tabIndex={-1}><Outlet /></main></div>
    <MobileNavigation label="Быстрые разделы админки" expanded={menu} onMore={() => setMenu(true)}>
      {quickLinks.map(([path, title, , icon]) => <NavLink end={path === "/"} key={path} to={path}><Icon name={icon} size={19} />{title}</NavLink>)}
    </MobileNavigation>
  </div>;
}

function Permit({ permission, children }: { permission: string; children: ReactNode }) {
  return useCan(permission) ? children : <><PageHeader title="Раздел закрыт" />
    <EmptyState title="Недостаточно прав"><p>У вашей роли нет разрешения.</p>
      <Link to="/" className={buttonClass("secondary")}>Вернуться к обзору</Link>
    </EmptyState></>;
}
function Users() {
  const canActivate = useCan("users:write");
  return <List title="Пользователи" path="/users" columns={["email", "id", "status", "activation", "emailVerified", "createdAt"]}
    filters={[["status", "Статус", ["ACTIVE", "BLOCKED"]]]} destination={row => "/users/" + row.id}>
    <UserCreate />
    {canActivate && <Link className={buttonClass("secondary")} to="/users/registrations">Ожидающие регистрации</Link>}
  </List>;
}
function UserDetails() {
  return <Detail title="Пользователь" path="/users">{row => <>
    <section className="mz-card panel"><Facts data={row} />
      <nav className="mz-actions" aria-label="Связанные записи пользователя">
        <Link className={buttonClass("secondary")} to={"/orders?userId=" + row.id}>Заказы</Link>
        <Link className={buttonClass("secondary")} to={"/jobs?userId=" + row.id}>Выдача</Link>
        <Link className={buttonClass("secondary")} to={"/support?forUserId=" + row.id}>Обращения</Link>
        <Link className={buttonClass("secondary")} to={"/users/" + row.id + "/periods"}>Периоды</Link>
      </nav>
    </section>
    <AccessActions row={row} />
  </>}</Detail>;
}
function OrderDetails() {
  const finance = useCan("finance:read");
  return <Detail title="Детали заказа" path="/orders">{row => <>
    <section className="mz-card panel"><h2>Снимок и текущее состояние</h2>
      <Facts data={row} keys={["id", "status", "allocated", "delivery", "revision", "snapshot", "entitlement", "owner"]} /></section>
    <section className="mz-card panel"><h2>От оплаты до подключения</h2>
      <div className="admin-trace"><Timeline>
        <li><h3>Платёжные попытки</h3><Facts data={row} keys={["attempts"]} />
          {finance && <Link to={"/orders/" + row.id + "/finance"}>Подтверждённые движения</Link>}</li>
        <li><h3>Распределение денег и период</h3><Facts data={row} keys={["allocation", "period"]} /></li>
        <li><h3>Задача выдачи</h3><Facts data={row} keys={["job"]} /></li>
        <li><h3>Наблюдения панели</h3><Facts data={row} keys={["observations"]} /></li>
      </Timeline></div>
      <Link to={"/support?orderId=" + row.id}>Обращения по заказу</Link></section>
    <OrderActions row={row} />
  </>}</Detail>;
}

function ForId({ render }: { render: (id: string) => ReactNode }) {
  // Scoped path segments are encoded in the API paths and validated at the server.
  const { id } = useParams();
  return render(encodeURIComponent(id ?? ""));
}
function OwnSessions() {
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<{ token: string; secret: string }>();
  const [codes, setCodes] = useState<string[]>([]);
  const cache = useQueryClient();
  const me = useSession()!;
  async function change(path: string, method: "POST" | "DELETE") {
    setIssue(""); setBusy(true);
    try { await api(path, { method }); await cache.invalidateQueries(); }
    catch (error) { setIssue(errorText(error)); }
    finally { setBusy(false); }
  }
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup || busy) return;
    const code = new FormData(event.currentTarget).get("code");
    setIssue(""); setBusy(true);
    try {
      const result = await api<{ recoveryCodes: string[] }>("/auth/2fa/enroll/confirm",
        { method: "POST", body: { stageToken: setup.token, code } });
      setSetup(undefined); setCodes(result.recoveryCodes); await cache.invalidateQueries();
    } catch (error) { setIssue(errorText(error)); }
    finally { setBusy(false); }
  }
  const policies = { required: "Обязательна", optional: "По выбору", disabled: "Отключена" };
  return <List title="Безопасность и сессии" path="/auth/sessions"
    columns={["id", "userAgent", "createdAt", "lastSeenAt", "expiresAt", "state", "current"]}
    actions={rows => <><div className="actions">{rows.filter(row => !row.revokedAt && row.state !== "EXPIRED").map(row =>
      <Button variant="secondary" disabled={busy} key={row.id} onClick={() => void change("/auth/sessions/" + row.id, "DELETE")}>
        {row.current ? "Завершить текущую сессию" : "Отозвать " + row.id.slice(0, 8)}</Button>)}</div>
      <Button variant="secondary" disabled={busy} onClick={() => void change("/auth/sessions/revoke-others", "POST")}>Завершить остальные сессии</Button>
      {issue && <p role="alert">{issue}</p>}</>}>
    {me.security && <section className="mz-card panel"><h2>Двухфакторная аутентификация</h2>
      <p>Политика: {policies[me.security.policy]}. Ключ {me.security.enrolled ? "подключён" : "не подключён"}.</p>
      {me.security.policy === "optional" && !setup && codes.length === 0 && (me.security.enrolled ?
        <Action title="Отключить собственную 2FA и завершить сеанс" operation="staff.self.totp.disable"
          permission="security:self" target={me.user.id} version={me.security.version}
          after={() => cache.invalidateQueries({ queryKey: ["admin-me"] })} /> :
        <Action title="Подключить 2FA" operation="staff.self.totp.enroll" permission="security:self" target={me.user.id} version={me.security.version}
          after={async result => {
            if (!result.stageToken) return;
            const response = await api<{ secret: string }>("/auth/2fa/enroll/start", { method: "POST", body: { stageToken: result.stageToken } });
            setSetup({ token: result.stageToken, secret: response.secret });
          }} />)}
      {setup && <form onSubmit={event => void confirm(event)}>
        <p>Добавьте ключ в приложение-аутентификатор. <CodeDisplay>{setup.secret}</CodeDisplay></p>
        <label>Код приложения<Input name="code" required autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" /></label>
        <Button type="submit" loading={busy}>Подключить</Button>
        <Button variant="quiet" onClick={() => setSetup(undefined)}>Отмена</Button>
      </form>}
      {codes.length > 0 && <><p>Сохраните резервные коды. Они показаны один раз.</p>
        <ul>{codes.map(code => <li key={code}><CodeDisplay>{code}</CodeDisplay></li>)}</ul>
        <Button onClick={() => setCodes([])}>Коды сохранены</Button></>}
    </section>}
  </List>;
}
type ServiceStatus = {
  key: string; state: "FRESH" | "STALE" | "UNAVAILABLE"; observedAt: string | null; reasonCode: string | null;
  data: Record<string, unknown> | null;
};
const serviceTitle: Record<string, string> = { panel: "Remnawave", worker: "Воркер выдачи" };
const serviceReason: Record<string, string> = {
  PANEL_PROBE_FAILED: "Панель не ответила на последнюю проверку.", PANEL_UNAVAILABLE: "Наблюдений панели пока нет.",
  NO_HEARTBEAT: "Сигнал воркера ещё не получен.", WORKER_STALE: "Сигнал воркера устарел.", WORKER_NOT_READY: "Воркер не готов к обработке.",
};

function Operations() {
  const service = useAdmin<{ asOf: string; services: ServiceStatus[] }>("/operations/status", 30_000);
  return <><PageHeader title="Сервисы" description="Состояние фоновых процессов и внешних зависимостей." />
    <RequestState state={service} />
    {service.data && <><p className="admin-meta">Снимок {valueText(service.data.asOf)}</p>
      {!service.data.services.length && <EmptyState title="Наблюдений пока нет" />}
      <div className="grid">{service.data.services.map(source => <section className="mz-card panel" key={source.key}>
        <div className="dashboard-source-heading"><h2>{serviceTitle[source.key] ?? source.key}</h2>
          <StatusIndicator status={source.state}>{states[source.state]}</StatusIndicator></div>
        {source.observedAt && <p className="admin-meta">Проверено {valueText(source.observedAt)}</p>}
        {source.reasonCode && <p>{serviceReason[source.reasonCode] ?? source.reasonCode}</p>}
        {source.data && <Facts data={source.data} />}
      </section>)}</div></>}
    <Settings />
  </>;
}

export default function AdminWorkspace() {
  return <Routes>
    <Route element={<Guard />}>
      <Route index element={<Dashboard />} />
      <Route path="users" element={<Users />} />
      <Route path="users/registrations" element={<Permit permission="users:write">
        <List title="Ожидающие регистрации" path="/users/registrations" columns={["email", "id", "createdAt", "expiresAt"]}
          actions={rows => rows.map(row => <Action key={row.id} title={`Активировать ${row.email}`}
            operation="user.registration.activate" permission="users:write" target={row.id} context={String(row.email)} version={String(row.version)}
            fields={[{ name: "temporaryPassword", label: "Пароль для проверенного получателя (24 часа)", type: "password" }]} />)}>
          <p>Передайте временный пароль только после идентификации заявителя по защищённому каналу.</p>
        </List>
      </Permit>} />
      <Route path="users/:id" element={<UserDetails />} />
      <Route path="users/:id/periods" element={<ForId render={id => <List title="Периоды доступа" path={`/users/${id}/periods`}
        columns={["orderId", "serial", "startAt", "endAt", "deviceLimit", "adjustment"]} />} />} />
      <Route path="orders" element={<List title="Заказы" path="/orders" columns={orderColumns} filters={orderFilters}
        destination={row => "/orders/" + row.id} />} />
      <Route path="orders/:id" element={<OrderDetails />} />
      <Route path="orders/:id/finance" element={<Permit permission="finance:read"><ForId render={id => <List title="Финансы заказа"
        path={`/orders/${id}/finance`} columns={["id", "kind", "currency", "amountMinor", "providerTime", "allocation"]}
        filters={[["kind", "Тип", ["transactions", "refunds", "disputes", "attempts"]]]} />} /></Permit>} />
      <Route path="payments" element={<Permit permission="finance:read"><List title="Денежные движения" path="/payments/transactions"
        columns={["id", "kind", "currency", "amountMinor", "providerTime", "allocation"]}
        filters={[["currency", "Валюта", ["RUB", "USD", "XTR"]], ["unallocated", "Не распределено", ["true"]]]}>
        <div className="mz-actions"><Link className={buttonClass("secondary")} to="/payments/cases">Дела сверки <Icon name="arrow" size={16} /></Link></div></List></Permit>} />
      <Route path="payments/cases" element={<Permit permission="finance:read"><List title="Дела сверки" path="/payments/cases"
        columns={["id", "kind", "status", "priority", "nextCheckAt", "updatedAt"]}
        filters={[["status", "Статус", ["OPEN", "INVESTIGATING", "RESOLVED"]]]} destination={row => "/payments/cases/" + row.id} /></Permit>} />
      <Route path="payments/cases/:id" element={<Permit permission="finance:read">
        <Detail title="Дело сверки" path="/payments/cases">{row => <><section className="mz-card panel"><Facts data={row} /></section>
          <Action title="Записать результат разбора" operation="payment.case_review" permission="finance:reconcile"
            target={row.id} version={String(row.version)} fields={[{ name: "disposition", label: "Исход", options: ["INVESTIGATING", "RESOLVED"] }]} />
        </>}</Detail>
      </Permit>} />
      <Route path="subscriptions" element={<List title="Подписки" path="/subscriptions"
        columns={["userId", "revision", "panelBinding", "_count", "nextBoundaryAt"]} filters={[["userId", "ID пользователя"]]}
        destination={row => "/users/" + row.userId} />} />
      <Route path="jobs" element={<List title="Очередь выдачи" path="/jobs" columns={jobColumns} filters={jobFilters}
        destination={row => "/jobs/" + row.id} />} />
      <Route path="jobs/:id" element={<Detail title="Задача выдачи" path="/jobs">{row => <>
        <section className="mz-card panel"><Facts data={row} /></section>
        {row.revision !== null && row.currentRevision === row.revision && <Action title="Запросить повторную проверку"
          operation="job.requeue" permission="jobs:write" target={row.id} version={String(row.revision)} />}
      </>}</Detail>} />
      <Route path="plans" element={<List title="Тарифы" path="/plans" columns={["name", "code", "revision", "deviceLimit", "isActive"]}
        filters={[["active", "Активен", ["true", "false"]]]} destination={row => "/plans/" + row.id}><PlanCreate /></List>} />
      <Route path="plans/:id" element={<PlanDetail actions={(plan, versions) => <PlanActions plan={plan} versions={versions} />} />} />
      <Route path="support" element={<List title="Обращения" path="/support/cases" columns={ticketColumns} filters={ticketFilters}
        destination={row => "/support/" + row.id} />} />
      <Route path="support/:id" element={<SupportDetail command={ticket => <Action title="Ответить или изменить статус" operation="support.action" permission="support:write"
        target={ticket.id} version={String(ticket.updatedAt)} fields={[
          { name: "status", label: "Новый статус", options: ["OPEN", "WAITING_CUSTOMER", "RESOLVED"], required: false },
          { name: "publicReply", label: "Публичный ответ", type: "textarea", required: false },
        ]} />} />} />
      <Route path="audit" element={<Permit permission="audit:read"><List title="Аудит" path="/audit"
        columns={["action", "actorId", "permission", "entityId", "reason", "commandId", "createdAt"]}
        filters={[["action", "Действие"], ["entity", "Объект"], ["actorId", "ID сотрудника"], ["entityId", "ID объекта"]]} destination={row => "/audit/" + row.id} /></Permit>} />
      <Route path="audit/:id" element={<Permit permission="audit:read"><Detail title="Запись аудита" path="/audit">
        {row => <section className="mz-card panel"><Facts data={row} /></section>}
      </Detail></Permit>} />
      <Route path="staff" element={<Permit permission="staff:read"><List title="Сотрудники" path="/staff"
        columns={["username", "displayName", "role", "status", "enrollmentState", "createdAt", "lastLoginAt", "activeSessions"]}
        filters={[["q", "Имя пользователя"], ["role", "Роль", ["OWNER", "ADMIN", "SUPPORT"]], ["status", "Статус", ["ACTIVE", "BLOCKED", "DEACTIVATED"]]]}
        destination={row => "/staff/" + row.id}><StaffCreate /><Invite /></List></Permit>} />
      <Route path="staff/:id" element={<Permit permission="staff:read"><Detail title="Сотрудник" path="/staff">{row => <>
        <section className="mz-card panel"><Facts data={row} /></section><StaffActions row={row} />
      </>}</Detail></Permit>} />
      <Route path="staff/:id/sessions" element={<Permit permission="staff:read">
        <Detail title="Сессии сотрудника" path="/staff">{staff => <List title="Устройства" nested path={`/staff/${staff.id}/sessions`}
          columns={["id", "userAgent", "createdAt", "lastSeenAt", "expiresAt", "state"]} actions={rows => rows.filter(row => !row.revokedAt).map(row =>
            <Action key={row.id} title={"Отозвать сессию · " + row.id.slice(0, 8)} operation="staff.session.revoke"
              permission="staff:write" version={String(staff.version)} target={staff.id} payload={{ sessionId: row.id }} />)} />}
        </Detail></Permit>} />
      <Route path="security" element={<OwnSessions />} />
      <Route path="operations" element={<Operations />} />
      <Route path="*" element={<><PageHeader title="Страница не найдена" /><EmptyState title="Проверьте адрес">
        <Link to="/" className={buttonClass("secondary")}>Вернуться к обзору</Link>
      </EmptyState></>} />
    </Route>
  </Routes>;
}
