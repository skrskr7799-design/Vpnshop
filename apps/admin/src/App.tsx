import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { BrowserRouter, Link, NavLink, Navigate, Outlet, Route, Routes, useNavigate, useParams } from "react-router";
import { api, ApiError, errorText } from "./api";
import { Login, Session, useCan, useSession, type Principal } from "./session";
import { Dashboard, Detail, Facts, jobColumns, jobFilters, List, orderColumns, orderFilters, PlanDetail,
  RequestState, SupportDetail, ticketColumns, ticketFilters, useAdmin, type Row } from "./views";

const navigation = [
  ["/", "Обзор", "dashboard:read"], ["/users", "Пользователи", "users:read"], ["/orders", "Заказы", "orders:read"],
  ["/payments", "Финансы", "finance:read"], ["/subscriptions", "Подписки", "users:read"], ["/jobs", "Выдача", "jobs:read"],
  ["/plans", "Тарифы", "plans:read"], ["/support", "Поддержка", "support:read"], ["/audit", "Аудит", "audit:read"],
  ["/staff", "Сотрудники", "staff:read"], ["/operations", "Сервисы", "ops:read"], ["/security", "Сессии", ""],
] as const;

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
  return hidden ? <main className="login"><p role="status">{error || "Выходим…"}</p>
    {error && <button onClick={() => void logout()}>Повторить выход</button>}</main> : <div className="shell">
    <a className="skip" href="#main">Перейти к содержимому</a>
    <aside className="sidebar"><NavLink to="/" className="brand">MZT</NavLink>
      <nav aria-label="Разделы администрирования">{navigation.filter(([, , perm]) => !perm || session.permissions.includes(perm)).map(([path, title]) =>
        <NavLink end={path === "/"} key={path} to={path}>{title}</NavLink>)}</nav>
    </aside>
    <div className="body"><header><span>{session.user.email} · {session.user.role}</span><button onClick={() => void logout()}>Выйти</button></header>
      <main id="main" tabIndex={-1}><Outlet /></main></div>
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
        <Link to={"/users/" + row.id + "/periods"}>Периоды</Link>
      </div>
    </section>
  </>}</Detail>;
}
function OrderDetails() {
  const finance = useCan("finance:read");
  return <Detail title="Детали заказа" path="/orders">{row => <>
    <section className="panel"><Facts data={row} keys={["id", "status", "allocated", "delivery", "revision", "snapshot", "entitlement", "owner"]} /></section>
    <section className="panel"><h2>Платёжные попытки</h2><Facts data={row} keys={["attempts", "allocation", "period"]} />
      {finance && <Link to={"/orders/" + row.id + "/finance"}>Подтверждённые движения</Link>}</section>
    <section className="panel"><h2>Выдача и наблюдения</h2><Facts data={row} keys={["job", "observations"]} />
      <Link to={"/support?orderId=" + row.id}>Обращения по заказу</Link></section>
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
  return <><h1>Сервисы</h1><RequestState state={service} />{service.data && <section className="panel"><Facts data={service.data} /></section>}</>;
}

export function App() {
  return <BrowserRouter><Routes>
    <Route path="/login" element={<Login />} /><Route path="/invitation" element={<Login invitation />} />
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
        filters={[["status", "Статус", ["OPEN", "INVESTIGATING", "RESOLVED"]]]} /></Permit>} />
      <Route path="subscriptions" element={<List title="Подписки" path="/subscriptions"
        columns={["userId", "revision", "panelBinding", "_count", "nextBoundaryAt"]} filters={[["userId", "ID пользователя"]]}
        destination={row => "/users/" + row.userId} />} />
      <Route path="jobs" element={<List title="Очередь выдачи" path="/jobs" columns={jobColumns} filters={jobFilters}
        destination={row => "/jobs/" + row.id} />} />
      <Route path="jobs/:id" element={<Detail title="Задача выдачи" path="/jobs">{row => <section className="panel"><Facts data={row} /></section>}</Detail>} />
      <Route path="plans" element={<List title="Тарифы" path="/plans" columns={["name", "code", "revision", "deviceLimit", "isActive"]}
        filters={[["active", "Активен", ["true", "false"]]]} destination={row => "/plans/" + row.id} />} />
      <Route path="plans/:id" element={<PlanDetail />} />
      <Route path="support" element={<List title="Обращения" path="/support/cases" columns={ticketColumns} filters={ticketFilters}
        destination={row => "/support/" + row.id} />} />
      <Route path="support/:id" element={<SupportDetail />} />
      <Route path="audit" element={<Permit permission="audit:read"><List title="Аудит" path="/audit"
        columns={["action", "actorId", "permission", "entityId", "reason", "commandId", "createdAt"]}
        filters={[["action", "Действие"], ["entity", "Объект"], ["actorId", "ID сотрудника"]]} /></Permit>} />
      <Route path="staff" element={<Permit permission="staff:read"><List title="Сотрудники" path="/staff"
        columns={["email", "role", "status", "enrollmentState", "version"]} filters={[["role", "Роль", ["ADMIN", "SUPPORT"]]]}
        destination={row => "/staff/" + row.id} /></Permit>} />
      <Route path="staff/:id" element={<Permit permission="staff:read"><ForId render={id => <List title="Сессии сотрудника"
        path={`/staff/${id}/sessions`} columns={["id", "userAgent", "lastSeenAt", "expiresAt", "revokedAt"]} />} /></Permit>} />
      <Route path="security" element={<OwnSessions />} />
      <Route path="operations" element={<Operations />} />
      <Route path="*" element={<><h1>Страница не найдена</h1><Link to="/">Вернуться к обзору</Link></>} />
    </Route>
  </Routes></BrowserRouter>;
}
