import { Badge, Button, Card, ConfirmDialog, EmptyState, Icon, PageHeader } from "@vpn/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { request } from "../../../api/client";
import { LoginMethods } from "../components/LoginMethods";
import { useLogout, useMe } from "../queries";
import { LoadState } from "../../account/account";

type Device = { id: string; device: string; createdAt: string; lastSeenAt: string; expiresAt: string; current: boolean };

export function SecurityPage() {
  const { data: user } = useMe();
  const logout = useLogout();
  const [error, setError] = useState("");
  const [target, setTarget] = useState<Device | "others" | null>(null);
  const [busy, setBusy] = useState(false);
  const devices = useQuery({
    queryKey: ["owner", user?.id, user?.sessionId, "devices"], retry: false,
    queryFn: ({ signal }) => request<{ sessions: Device[] }>("/auth/sessions", { signal }),
  });
  async function revoke(id?: string) {
    setError("");
    setBusy(true);
    try {
      if (id) await request(`/auth/sessions/${id}`, { method: "DELETE" });
      else await request("/auth/sessions/revoke-others", { method: "POST" });
      await devices.refetch();
      setTarget(null);
    } catch { setError("Сервер не подтвердил отзыв. Обновите список и повторите действие."); }
    finally { setBusy(false); }
  }
  return <>
    <PageHeader title="Безопасность" description={user?.email ? "Почта аккаунта: " + user.email : "Способы входа и активные устройства."} />
    <div className="mzt-security-grid"><Card className="mzt-panel"><LoginMethods /></Card>
    <Card className="mzt-panel" aria-labelledby="sessions-title">
      <h2 className="mzt-section-title" id="sessions-title"><Icon name="terminal" size={20} />Активные устройства</h2>
      <LoadState pending={devices.isPending} error={devices.error} retry={devices.refetch} />
      {devices.data?.sessions.length === 0 && <EmptyState title="Активных устройств нет" />}
      {!!devices.data?.sessions.length && <ul className="login-methods__list">{devices.data.sessions.map(device => <li className="login-methods__row" key={device.id}>
        <div><Badge tone={device.current ? "accent" : "neutral"}>{device.current ? "Текущее устройство" : "Другой вход"}</Badge>
          <p>{device.device}</p>
          {device.createdAt && <p className="mz-muted">Вход <time dateTime={device.createdAt}>{new Date(device.createdAt).toLocaleString("ru-RU")}</time></p>}
          <p className="mz-muted">Последняя активность <time dateTime={device.lastSeenAt}>{new Date(device.lastSeenAt).toLocaleString("ru-RU")}</time></p>
        </div>
        {device.current ? <Button variant="secondary" onClick={() => logout.mutate()}>Выйти с этого устройства</Button> :
          <Button variant="secondary" onClick={() => { setError(""); setTarget(device); }}>Отозвать</Button>}
      </li>)}</ul>}
      {(devices.data?.sessions.length ?? 0) > 1 && <Button variant="danger" onClick={() => { setError(""); setTarget("others"); }}>Отозвать остальные</Button>}
    </Card></div>
    <ConfirmDialog open={target !== null} title="Отозвать доступ" confirmLabel="Отозвать" busy={busy}
      onClose={() => { setTarget(null); setError(""); }} onConfirm={() => void revoke(target === "others" ? undefined : target?.id)}>
      <p>{target === "others" ? "Остальные устройства выйдут из аккаунта." : target?.device}</p>
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>
  </>;
}
