import { Button, Card, CopyField, Icon, PageHeader, type IconName, StatusIndicator, buttonClass } from "@vpn/ui";
import qrcode from "qrcode-generator";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useProductConfig } from "../../config";
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
  const revealButton = useRef<HTMLButtonElement>(null);
  const delivery = sub ? displayDelivery(sub) : null;
  const allowed = sub?.linkAllowed !== false;
  const ready = allowed && !query.isError && delivery === "READY" && sub?.rightStatus === "ACTIVE";
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
            : <p className="mz-muted">{!allowed ? "Получение ссылки отключено. По вопросам доступа обратитесь в поддержку." : sub?.rightStatus === "HELD" ? "Доступ приостановлен. Обратитесь в поддержку." :
              sub?.rightStatus === "EXPIRED" ? "Продлите подписку, чтобы получить данные подключения." :
              "Данные появятся после начала периода и подтверждения профиля панелью."}</p>}
          {!compact && sub?.delivery.observedAt && <p className="mz-muted">Последнее подтверждение {date(sub.delivery.observedAt)}</p>}
        </div>
        {ready && !visible && <Button ref={revealButton} variant="secondary" loading={pending} onClick={() => void reveal()}>
          <Icon name="qr" size={17} />Показать ссылку и QR
        </Button>}
      </div>
      {message && <p role="status">{message}</p>}
      {visible && <div className="mzt-private">
        <p className="mz-muted">Ссылка даёт доступ к вашей подписке. Она скроется через минуту.</p>
        <div className="mzt-private__data">
          <CopyField label="Ссылка подписки" value={visible.url} />
          <svg className="mzt-qr" role="img" aria-label="QR-код подписки"
            viewBox={`0 0 ${visible.qr.size} ${visible.qr.size}`}>
            <rect width="100%" height="100%" fill="white" /><path fill="black" d={visible.qr.path} />
          </svg>
        </div>
        <div><Button variant="secondary" onClick={() => {
          setRevealed(null);
          requestAnimationFrame(() => revealButton.current?.focus());
        }}>Скрыть</Button></div>
      </div>}
    </Card>}
  </>;
}

const platforms = {
  ios: { label: "iPhone и iPad", icon: "phone", source: "App Store" },
  android: { label: "Android", icon: "phone", source: "Google Play" },
  androidTv: { label: "Android TV", icon: "tv", source: "Google Play на телевизоре" },
  appleTv: { label: "Apple TV", icon: "tv", source: "App Store на Apple TV" },
  windows: { label: "Windows", icon: "laptop", source: "сайта разработчика" },
  mac: { label: "macOS", icon: "laptop", source: "App Store или сайта разработчика" },
  other: { label: "Другое устройство", icon: "monitor", source: null },
} satisfies Record<string, { label: string; icon: IconName; source: string | null }>;
type Platform = keyof typeof platforms;

function detectedPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/AppleTV|tvOS/i.test(ua)) return "appleTv";
  if (/Android.*(?:TV|AFT)|GoogleTV/i.test(ua)) return "androidTv";
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh/i.test(ua)) return "mac";
  return "other";
}

export function ConnectionPage() {
  const [platform, setPlatform] = useState(detectedPlatform);
  const selection = platforms[platform];
  const paymentsEnabled = useProductConfig().data?.availability.payments === true;
  const overview = useOwner<OwnerSubscription>("/me/subscription");
  const subscription = !overview.isError && overview.data?.subscription;
  const period = subscription && subscription.currentPeriod;
  return <><PageHeader title="Подключение" description="Добавьте подписку MZT в VPN-клиент." />
    <ConnectionCard />
    {paymentsEnabled && subscription && ["ACTIVE", "EXPIRED"].includes(subscription.rightStatus) &&
      <Card className="mzt-panel"><h2 className="mzt-section-title"><Icon name="clock" size={20} />Продление</h2>
        {subscription.coverageEndsAt && <p>Доступ до {date(subscription.coverageEndsAt)}{period && ` · До ${period.deviceLimit} устройств`}</p>}
        <Link className={buttonClass("secondary")} to="/account/plans?renewal=1">Продлить подписку</Link>
      </Card>}
    <Card className="mzt-panel"><h2 className="mzt-section-title"><Icon name="help" size={20} />Как подключиться</h2>
      <div className="mzt-platform"><Icon name={selection.icon} size={22} />
        <label htmlFor="connect-platform">Устройство</label>
        <select id="connect-platform" className="mz-control" value={platform} onChange={event => setPlatform(event.target.value as Platform)}>
          {Object.entries(platforms).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}
        </select>
      </div>
      <ol className="mzt-steps">
        <li>{selection.source ? <>Установите из {selection.source} VPN-клиент с импортом подписок по ссылке.</>
          : "На нужном устройстве откройте VPN-клиент, который поддерживает импорт подписок."}</li>
        <li>Скопируйте ссылку подписки или покажите QR-код и отсканируйте его с нужного устройства, если клиент поддерживает QR.</li>
        <li>Импортируйте подписку, обновите список и выберите доступный профиль.</li>
      </ol>
    </Card>
  </>;
}
