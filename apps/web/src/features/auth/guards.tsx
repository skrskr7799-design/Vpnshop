import { Navigate, Outlet, useLocation } from "react-router";
import { PageStatus } from "../../components/PageStatus/PageStatus";
import { useMe } from "./queries";
import { getRedirectTarget } from "./redirect";

// Страницы только для вошедших. Пока неизвестно, кто пользователь, показываем загрузку.
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <PageStatus kind="loading" />;
  if (me.isError) return <PageStatus kind="error" onRetry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet key={me.data.sessionId} />;
}

// Страницы входа и регистрации: вошедшего пользователя отправляем дальше.
export function GuestOnly() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <PageStatus kind="loading" />;
  // API недоступен: форму всё равно показываем, ошибку пользователь увидит при отправке
  if (me.data) return <Navigate to={getRedirectTarget(location.state)} replace />;
  return <Outlet />;
}
