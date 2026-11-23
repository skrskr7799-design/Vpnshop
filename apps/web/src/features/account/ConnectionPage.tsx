import { Button, Card, CopyField, Icon, PageHeader, StatusIndicator } from "@vpn/ui";
import qrcode from "qrcode-generator";
import { useEffect, useRef, useState } from "react";
import type { OwnerSubscription } from "@vpn/shared";
import { request } from "../../api/client";
import { date, displayDelivery, errorMessage, label, LoadState, useOwner } from "./account";

export function makeQr(value: string) {
  const qr = qrcode(0, "M");
  qr.addData(value, "Byte");
  qr.make();
  const cells = qr.getModuleCount();
  let path = "";
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) if (qr.isDark(row, col)) path += `M${col + 4},${row + 4}h1v1h-1z`;
  }
  return { path, size: cells + 8 };
}

export function ConnectionCard({ compact = false }: { compact?: boolean }) {
  const query = useOwner<OwnerSubscription>("/me/subscription", 10_000);
  const sub = query.data?.subscription;
  const [revealed, setRevealed] = useState<{ id: string; url: string; qr: ReturnType<typeof makeQr> } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const requestRef = useRef<AbortController>(null);
  const delivery = sub ? displayDelivery(sub) : null;
  const ready = !query.isError && delivery === "READY" && sub?.rightStatus === "ACTIVE";
  const periodId = sub?.currentPeriod?.id;
  const visible = ready && revealed?.id === periodId ? revealed : null;
  useEffect(() => {
    setRevealed(current => ready && current?.id === periodId ? current : null);
    const hide = () => setRevealed(null);
    window.addEventListener("pagehide", hide);
    return () => { window.removeEventListener("pagehide", hide); requestRef.current?.abort(); };
  }, [ready, periodId]);
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setRevealed(null), 60_000);
    return () => clearTimeout(t);
  }, [visible]);
  async function reveal() {
    if (!periodId || !ready || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setPending(true); setMessage("");
    try {
      const { subscriptionUrl: url } = await request<{ subscriptionUrl: string }>("/me/subscription/access", { method: "POST", body: {}, signal: controller.signal });
      if (new URL(url).protocol !== "https:") throw new Error();
      if (controller.signal.aborted) return;
      setRevealed({ id: periodId, url, qr: makeQr(url) });
    } catch (err) {
      if (controller.signal.aborted) return;
      setRevealed(null);
      setMessage(errorMessage(err));
      await query.refetch();
    } finally { requestRef.current = null; setPending(false); }
  }
  return <>
    {!compact && <LoadState pending={query.isPending} error={query.error} retry={query.refetch} />}
    {query.data && !query.isError && <Card className="mzt-connection">
      <div className="mzt-panel-heading"><h2><Icon name="key" size={20} />Данные для подключения</h2>
        <StatusIndicator status={delivery ?? "EMPTY"}>{delivery ? label(delivery) : "Подписка отсутствует"}</StatusIndicator></div>
      <div className="mzt-connection__row">
        <span className="mzt-connection__icon"><Icon name="connect" size={20} /></span>
        <div>
          <p className="mzt-connection__name">Ссылка подписки</p>
          {ready ? <p className="mz-muted">Для импорта в VPN-клиент</p>
            : <p className="mz-muted">{sub?.rightStatus === "HELD" ? "Доступ приостановлен. Обратитесь в поддержку." :
              sub?.rightStatus === "EXPIRED" ? "Продлите подписку, чтобы получить данные подключения." :
              "Данные появятся после начала периода и подтверждения профиля панелью."}</p>}
          {!compact && sub?.delivery.observedAt && <p className="mz-muted">Последнее подтверждение {date(sub.delivery.observedAt)}</p>}
        </div>
        {ready && !visible && <Button variant="secondary" loading={pending} onClick={() => void reveal()}>
          <Icon name="lock" size={17} />Показать ссылку и QR
        </Button>}
      </div>
      {message && <p role="status">{message}</p>}
      {visible && <div className="mzt-private">
        <p className="mz-muted">Ссылка даёт доступ к вашей подписке. Она скроется через минуту.</p>
        <CopyField label="Ссылка подписки" value={visible.url} />
        <svg className="mzt-qr" role="img" aria-label="QR-код подписки"
          viewBox={`0 0 ${visible.qr.size} ${visible.qr.size}`}>
          <rect width="100%" height="100%" fill="white" /><path fill="black" d={visible.qr.path} />
        </svg>
        <div><Button variant="secondary" onClick={() => setRevealed(null)}>Скрыть</Button></div>
      </div>}
    </Card>}
  </>;
}

export function ConnectionPage() {
  return <><PageHeader title="Подключение" description="Добавьте подписку MZT в VPN-клиент." />
    <ConnectionCard />
    <Card><h2>Как подключиться</h2><ol className="mzt-steps">
      <li>Откройте совместимый VPN-клиент, который поддерживает импорт подписки.</li>
      <li>Добавьте подписку по ссылке или отсканируйте QR-код с другого устройства.</li>
      <li>Обновите список подключений в клиенте и выберите доступный профиль.</li>
    </ol></Card>
  </>;
}
