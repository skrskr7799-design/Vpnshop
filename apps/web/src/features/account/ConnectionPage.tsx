import qrcode from "qrcode-generator";
import { useEffect, useState } from "react";
import type { OwnerSubscription } from "@vpn/shared";
import { request } from "../../api/client";
import { date, errorMessage, label, LoadState, useOwner } from "./account";

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

export function ConnectionPage() {
  const query = useOwner<OwnerSubscription>("/me/subscription", 10_000);
  const sub = query.data?.subscription;
  const [revealed, setRevealed] = useState<{ id: string; url: string; qr: ReturnType<typeof makeQr> } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const ready = !query.isError && sub?.delivery.status === "READY" && sub.rightStatus === "ACTIVE";
  const periodId = sub?.currentPeriod?.id;
  const visible = ready && revealed?.id === periodId ? revealed : null;
  useEffect(() => {
    setRevealed(current => ready && current?.id === periodId ? current : null);
    const hide = () => setRevealed(null);
    window.addEventListener("pagehide", hide);
    return () => window.removeEventListener("pagehide", hide);
  }, [ready, periodId]);
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => setRevealed(null), 60_000);
    return () => clearTimeout(t);
  }, [visible]);
  async function reveal() {
    if (!periodId) return;
    setPending(true); setMessage("");
    try {
      const { subscriptionUrl: url } = await request<{ subscriptionUrl: string }>("/me/subscription/access", { method: "POST", body: {} });
      if (new URL(url).protocol !== "https:") throw new Error();
      setRevealed({ id: periodId, url, qr: makeQr(url) });
    } catch (err) {
      setRevealed(null);
      setMessage(errorMessage(err));
      await query.refetch();
    } finally { setPending(false); }
  }
  return <><h1>Подключение</h1>
    <LoadState pending={query.isPending} error={query.error} retry={query.refetch} />
    {query.data && <section className="mzt-panel">
      <h2>{sub ? label(sub.delivery.status) : "Подписка отсутствует"}</h2>
      {sub && <p>Последнее подтверждение {date(sub.delivery.observedAt)}</p>}
      {ready && <button disabled={pending} onClick={() => void reveal()}>Показать ссылку и QR</button>}
      {message && <p role="status">{message}</p>}
      {visible && <>
        <svg className="mzt-qr" role="img" aria-label="QR-код подписки"
          viewBox={`0 0 ${visible.qr.size} ${visible.qr.size}`}>
          <rect width="100%" height="100%" fill="white" /><path fill="black" d={visible.qr.path} />
        </svg>
        <label>Ссылка подписки <input readOnly value={visible.url} /></label>
        <div className="mzt-actions">
          <button onClick={() => void navigator.clipboard.writeText(visible.url)
            .then(() => setMessage("Ссылка скопирована.")).catch(() => setMessage("Выделите ссылку и скопируйте вручную."))}>Копировать</button>
          <button onClick={() => setRevealed(null)}>Скрыть</button>
        </div>
      </>}
    </section>}
    <section className="mzt-panel"><h2>Как подключиться</h2><ol>
      <li>Откройте совместимый VPN-клиент, который поддерживает импорт подписки.</li>
      <li>Добавьте подписку по ссылке или отсканируйте QR-код с другого устройства.</li>
      <li>Обновите список подключений в клиенте и выберите доступный профиль.</li>
    </ol></section>
  </>;
}
