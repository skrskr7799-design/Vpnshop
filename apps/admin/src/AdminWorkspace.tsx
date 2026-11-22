import { Badge, Button, Drawer, Icon, IconButton, PageHeader, Timeline, type IconName } from "@vpn/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { Action } from "./commands";
import { AccessActions, Invite, OrderActions, PlanActions, PlanCreate, Settings, StaffActions } from "./actions";
import { api, ApiError, errorText } from "./api";
import { Session, useCan, useSession, type Principal } from "./session";
import { Dashboard, Detail, Facts, jobColumns, jobFilters, List, orderColumns, orderFilters, PlanDetail,
  RequestState, SupportDetail, ticketColumns, ticketFilters, useAdmin, type Row } from "./views";

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
  if (me.isPending || me.isError) return <main className="login"><RequestState state={me} /></main>;
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
  const active = visibleGroups.flatMap(group => group.links).find(([path]) => path !== "/" && location.pathname.startsWith(path))?.[1] ?? "Обзор";
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
      {group.links.map(([path, title, , icon]) => <NavLink end={path === "/"} key={path} to={path} onClick={close}>
        <Icon name={icon} size={17} />{title}</NavLink>)}
    </section>)}
  </nav>;
  return hidden ? <main className="login"><p role="status">{error || "Выходим…"}</p>
    {error && <Button variant="secondary" onClick={() => void logout()}>Повторить выход</Button>}</main> : <div className="shell">
    <a className="skip" href="#main">Перейти к содержимому</a>
    <aside className="sidebar"><div className="admin-brand"><NavLink to="/" className="mz-wordmark">MZT</NavLink><span>Администрирование</span></div>{navigation()}</aside>
    <div className="body"><header className="admin-topbar">
      <div className="admin-topbar__mobile"><IconButton icon="menu" label="Открыть меню" aria-expanded={menu} onClick={() => setMenu(true)} />
        <Link to="/" className="mz-wordmark">MZT</Link></div>
      <span className="admin-topbar__context">{active}</span>
      <div className="admin-topbar__identity"><span className="admin-topbar__email">{session.user.email}</span>
        <Badge tone="accent">{session.user.role}</Badge>
        <Button variant="quiet" onClick={() => void logout()}><Icon name="out" size={16} />Выйти</Button></div>
    </header>
      <Drawer open={menu} title="Администрирование" onClose={() => setMenu(false)}>{navigation(() => {
        setMenu(false);
        requestAnimationFrame(() => main.current?.focus({ preventScroll: true }));
      })}</Drawer>
      <main id="main" className="admin-main" ref={main} tabIndex={-1}><Outlet /></main></div>
  </div>;
}

function Permit({ permission, children }: { permission: string; children: ReactNode }) {
  return useCan(permission) ? children : <><h1>Раздел закрыт</h1><p>У вашей роли нет разрешения.</p></>;
}
function UserDetails() {
  return <Detail title="Пользователь" path="/users">{row => <>
    <section className="panel"><Facts data={row} />
      <div className="actions">
        <Link to={"/orders?userId=" + row.id}>Заказы</Link>
        <Link to={"/jobs?userId=" + row.id}>Выдача</Link>
        <Link to={"/support?forUserId=" + row.id}>Обращения</Link>
        <Link to={"/users/" + row.id + "/periods"}>Периоды</Link>
      </div>
    </section>
    <AccessActions row={row} />
  </>}</Detail>;
}
function OrderDetails() {
  const finance = useCan("finance:read");
  return <Detail title="Детали заказа" path="/orders">{row => <>
    <section className="panel"><h2>Снимок и текущее состояние</h2>
      <Facts data={row} keys={["id", "status", "allocated", "delivery", "revision", "snapshot", "entitlement", "owner"]} /></section>
    <section className="panel"><h2>От оплаты до подключения</h2>
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
  const cache = useQueryClient();
  async function revoke(row: Row) {
    setIssue("");
    try { await api("/auth/sessions/" + row.id, { method: "DELETE" }); await cache.invalidateQueries(); }
    catch (error) { setIssue(errorText(error)); }
  }
  return <List title="Административные сессии" path="/auth/sessions"
    columns={["id", "userAgent", "lastSeenAt", "expiresAt", "revokedAt", "current"]}
    actions={rows => <><div className="actions">{rows.filter(row => !row.revokedAt).map(row =>
      <button key={row.id} onClick={() => void revoke(row)}>{row.current ? "Завершить текущую сессию" : "Отозвать " + row.id.slice(0, 8)}</button>)}</div>
      {issue && <p role="alert">{issue}</p>}</>} />;
}
function Operations() {
  const service = useAdmin<Record<string, unknown>>("/operations/status", 30_000);
  return <><PageHeader title="Сервисы" description="Состояние фоновых процессов и внешних зависимостей." /><RequestState state={service} />{service.data && <section className="panel"><Facts data={service.data} /></section>}<Settings /></>;
}

export default function AdminWorkspace() {
  return <Routes>
    <Route element={<Guard />}>
      <Route index element={<Dashboard />} />
      <Route path="users" element={<List title="Пользователи" path="/users" columns={["email", "id", "status", "createdAt"]}
        filters={[["status", "Статус", ["ACTIVE", "BLOCKED"]]]} destination={row => "/users/" + row.id} />} />
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
        <Link to="/payments/cases">Дела сверки</Link></List></Permit>} />
      <Route path="payments/cases" element={<Permit permission="finance:read"><List title="Дела сверки" path="/payments/cases"
        columns={["id", "kind", "status", "priority", "nextCheckAt", "updatedAt"]}
        filters={[["status", "Статус", ["OPEN", "INVESTIGATING", "RESOLVED"]]]} destination={row => "/payments/cases/" + row.id} /></Permit>} />
      <Route path="payments/cases/:id" element={<Permit permission="finance:read">
        <Detail title="Дело сверки" path="/payments/cases">{row => <><section className="panel"><Facts data={row} /></section>
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
        <section className="panel"><Facts data={row} /></section>
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
        {row => <section className="panel"><Facts data={row} /></section>}
      </Detail></Permit>} />
      <Route path="staff" element={<Permit permission="staff:read"><List title="Сотрудники" path="/staff"
        columns={["email", "role", "status", "enrollmentState", "version"]} filters={[["role", "Роль", ["ADMIN", "SUPPORT"]]]}
        destination={row => "/staff/" + row.id}><Invite /></List></Permit>} />
      <Route path="staff/:id" element={<Permit permission="staff:read"><Detail title="Сотрудник" path="/staff">{row => <>
        <section className="panel"><Facts data={row} /></section><StaffActions row={row} />
      </>}</Detail></Permit>} />
      <Route path="staff/:id/sessions" element={<Permit permission="staff:read">
        <Detail title="Сессии сотрудника" path="/staff">{staff => <List title="Устройства" path={`/staff/${staff.id}/sessions`}
          columns={["id", "userAgent", "lastSeenAt", "expiresAt", "revokedAt"]} actions={rows => rows.filter(row => !row.revokedAt).map(row =>
            <Action key={row.id} title={"Отозвать сессию · " + row.id.slice(0, 8)} operation="staff.session.revoke"
              permission="staff:write" version={String(staff.version)} target={staff.id} payload={{ sessionId: row.id }} />)} />}
        </Detail></Permit>} />
      <Route path="security" element={<OwnSessions />} />
      <Route path="operations" element={<Operations />} />
      <Route path="*" element={<><h1>Страница не найдена</h1><Link to="/">Вернуться к обзору</Link></>} />
    </Route>
  </Routes>;
}
