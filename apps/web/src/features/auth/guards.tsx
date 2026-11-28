import { useEffect, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { MazeOpening } from "@vpn/ui";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { PageStatus } from "../../components/PageStatus/PageStatus";
import { useMe } from "./queries";
import { loadDashboard, loginMutationKey, oauthMethodParam, playEntry, rememberEntryMethod } from "./entry";
import { getRedirectTarget } from "./redirect";

// Страницы только для вошедших. Пока неизвестно, кто пользователь, показываем загрузку.
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <PageStatus kind="loading" />;
  if (me.isError) return <PageStatus kind="error" onRetry={() => void me.refetch()} />;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location }} />;
  const method = new URLSearchParams(location.search).get(oauthMethodParam);
  if (method !== null) {
    const confirmed = me.data.loginMethod;
    return <OAuthEntry key={location.key} method={method === confirmed && (confirmed === "google" || confirmed === "telegram") ? confirmed : undefined} />;
  }
  return <Outlet key={me.data.sessionId} />;
}

function OAuthEntry({ method }: { method?: "google" | "telegram" }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams(location.search);
    query.delete(oauthMethodParam);
    const target = { pathname: location.pathname, search: query.toString(), hash: location.hash };

    void (async () => {
      if (method) {
        rememberEntryMethod(method);
        const ready = await loadDashboard().then(() => true, () => false);
        if (ready && !controller.signal.aborted) await playEntry(() => setOpening(true), controller.signal);
      }
      if (!controller.signal.aborted) void navigate(target, { replace: true });
    })();

    return () => controller.abort();
  }, [method, location, navigate]);

  return opening ? <MazeOpening /> : <PageStatus kind="loading" />;
}

// Страницы входа и регистрации: вошедшего пользователя отправляем дальше.
export function GuestOnly() {
  const signingIn = useIsMutating({ mutationKey: loginMutationKey }) > 0;
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <PageStatus kind="loading" />;
  // API недоступен: форму всё равно показываем, ошибку пользователь увидит при отправке
  if (me.data && !signingIn) return <Navigate to={getRedirectTarget(location.state)} replace />;
  return <Outlet />;
}
