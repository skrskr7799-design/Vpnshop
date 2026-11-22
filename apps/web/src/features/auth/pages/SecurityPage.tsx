import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { request } from "../../../api/client";
import { LoginMethods } from "../components/LoginMethods";
import { useLogout, useMe } from "../queries";

type Device = { id: string; device: string; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean };

export function SecurityPage() {
  const { data: user } = useMe();
  const logout = useLogout();
  const [error, setError] = useState("");
  const devices = useQuery({
    queryKey: ["owner", user?.id, user?.sessionId, "devices"], retry: false,
    queryFn: ({ signal }) => request<{ sessions: Device[] }>("/auth/sessions", { signal }),
  });
  async function revoke(id?: string) {
    setError("");
    try {
      if (id) await request(`/auth/sessions/${id}`, { method: "DELETE" });
      else await request("/auth/sessions/revoke-others", { method: "POST" });
      await devices.refetch();
    } catch { setError("Сервер не подтвердил отзыв. Обновите список и повторите действие."); }
  }
  return <>
    <Link to="/account">Кабинет</Link>
    <h1>Безопасность</h1>
    {user?.email && <p>Почта аккаунта: {user.email}</p>}
    <LoginMethods />
    <section aria-labelledby="sessions-title">
      <h2 id="sessions-title">Активные устройства</h2>
      {devices.isPending && <p>Загружаем устройства…</p>}
      {(devices.isError || error) && <p role="alert">{error || "Не удалось загрузить устройства."}</p>}
      {devices.data?.sessions.length === 0 && <p>Активных устройств нет.</p>}
      <ul className="login-methods__list">{devices.data?.sessions.map(device => <li key={device.id}>
        <p>{device.current ? "Текущее устройство" : "Другой вход"} · {device.device}</p>
        <p>Последняя активность {new Date(device.lastSeenAt).toLocaleString("ru-RU")}</p>
        {device.current ? <button onClick={() => logout.mutate()}>Выйти</button> :
          <button onClick={() => void revoke(device.id)}>Отозвать</button>}
      </li>)}</ul>
      {(devices.data?.sessions.length ?? 0) > 1 && <button onClick={() => void revoke()}>Отозвать остальные</button>}
    </section>
  </>;
}
