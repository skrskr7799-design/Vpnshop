import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentPropsWithRef, type HTMLAttributes,
  type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Icon, type IconName } from "./icons";
import { LabyrinthBackground } from "./maze";
export { Icon, Labyrinth, type IconName } from "./icons";
export { LabyrinthBackground, MazeOpening, mazeOpeningMs } from "./maze";

const brandMarkUrl = new URL("./assets/mzt-logo.svg", import.meta.url).href;

export function BrandMark() {
  return <img className="mz-brand-mark" src={brandMarkUrl} width={804} height={804} alt="MZT" />;
}

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "accent";
export function buttonClass(kind = "primary", block = false) {
  return ["mz-button", "mz-button--" + kind, block && "mz-button--block"].filter(Boolean).join(" ");
}
export function Button({ variant = "primary", block, loading, disabled, type = "button", className = "", children, ...props }:
  ComponentPropsWithRef<"button"> & { variant?: "primary" | "secondary" | "quiet" | "danger"; block?: boolean; loading?: boolean }) {
  return <button {...props} type={type} className={buttonClass(variant, block) + " " + className}
    disabled={disabled || loading} aria-busy={loading || undefined}>
    {loading && <span className="mz-spinner" aria-hidden="true" />}{children}
  </button>;
}
export function IconButton({ icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <Button variant="quiet" {...props} className="mz-icon-button" aria-label={label}><Icon name={icon} /></Button>;
}
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={"mz-control " + className} />;
}
export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={"mz-control " + className} />;
}
export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={"mz-control " + className} />;
}
export function FormField({ label, hint, error, children }: { label: ReactNode; hint?: string; error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode }) {
  const id = useId();
  return <div className="mz-field"><label htmlFor={id}>{label}</label>
    {children({ id, "aria-describedby": hint || error ? id + "-note" : undefined, "aria-invalid": error ? true : undefined })}
    {(hint || error) && <p id={id + "-note"} className={error ? "mz-error" : "mz-muted"} role={error ? "alert" : undefined}>{error ?? hint}</p>}
  </div>;
}
export function PasswordInput({ className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  return <span className="mz-password"><Input {...props} className={className} type={visible ? "text" : "password"} />
    <button className="mz-password-toggle" type="button" aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
      onClick={() => setVisible(value => !value)}><Icon name={visible ? "eyeOff" : "eye"} size={18} /></button>
  </span>;
}
export function Checkbox({ children, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <label className="mz-check"><input {...props} type="checkbox" />{children}</label>;
}
export function Switch({ children, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return <label className="mz-check mz-switch"><input {...props} type="checkbox" role="switch" />{children}</label>;
}
export function Tabs({ label, items, value, onChange, children }: { label: string; items: { value: string; label: string }[];
  value: string; onChange: (value: string) => void; children: ReactNode }) {
  const id = useId();
  const selected = items.findIndex(item => item.value === value);
  function handleKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
      event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : null;
    if (next === null) return;
    event.preventDefault();
    onChange(items[next]!.value);
    document.getElementById(id + "-" + next)?.focus();
  }
  return <><div role="tablist" aria-label={label} className="mz-tabs">{items.map((item, index) =>
    <button key={item.value} role="tab" type="button" aria-selected={index === selected} tabIndex={index === selected ? 0 : -1}
      id={id + "-" + index} aria-controls={id + "-panel"} onClick={() => onChange(item.value)}
      onKeyDown={event => handleKey(event, index)}>{item.label}</button>)}</div>
    <div role="tabpanel" id={id + "-panel"} aria-labelledby={id + "-" + selected} tabIndex={0}>{children}</div></>;
}
export function statusTone(status: string): Tone {
  if (["ACTIVE", "READY", "FRESH", "CONFIRMED", "SUCCEEDED", "CAPTURE_RECORDED", "ALLOCATED", "RESOLVED", "FULFILLED"].includes(status)) return "success";
  if (["HELD", "HOLD", "FAILED", "UNAVAILABLE", "BLOCKED"].includes(status)) return "danger";
  if (["UNKNOWN", "STALE", "NEEDS_REVIEW", "REVIEW", "LEGACY_REVIEW", "LATE_CAPTURE", "VERIFY_PENDING", "RETRY_WAIT", "INVESTIGATING"].includes(status)) return "warning";
  if (["OPEN", "WAITING", "PROCESSING", "PENDING", "AWAITING_CUSTOMER", "RUNNING", "SCHEDULED", "WAITING_EXTERNAL"].includes(status)) return "info";
  return "neutral";
}
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className="mz-badge" data-tone={tone}>{children}</span>;
}
export function StatusIndicator({ status, children }: { status: string; children: ReactNode }) {
  return <Badge tone={statusTone(status)}><span className="mz-status-dot" aria-hidden="true" />{children}</Badge>;
}
export function Card({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section {...props} className={"mz-card " + className} />;
}
export function MetricCard({ label, value, icon, children }: { label: string; value: ReactNode; icon?: IconName; children?: ReactNode }) {
  return <Card className="mz-metric">{icon && <span className="mz-metric-icon"><Icon name={icon} /></span>}
    <div className="mz-metric-body"><h2>{label}</h2><div className="mz-metric-value">{value}</div>{children}</div></Card>;
}
export function SignatureScene({ brand, children, mainId }: { brand: ReactNode; children: ReactNode; mainId?: string }) {
  return <div className="mz-signature-scene">
    <LabyrinthBackground scene="login" />
    {mainId && <a className="mz-skip" href={`#${mainId}`}>Перейти к форме</a>}
    <div className="mz-signature-brand">{brand}</div>
    <main id={mainId} className="mz-signature-panel mz-cut mz-cut--auth" tabIndex={mainId ? -1 : undefined}>
      {children}
    </main>
  </div>;
}
export function MobileNavigation({ label, expanded, onMore, children }: {
  label: string; expanded: boolean; onMore: () => void; children: ReactNode;
}) {
  return <nav className="mz-mobile-nav" aria-label={label}>{children}
    <button type="button" aria-expanded={expanded} onClick={onMore}><Icon name="more" size={19} />Ещё</button>
  </nav>;
}
type DialogProps = { open: boolean; title: string; onClose: () => void; children: ReactNode; busy?: boolean; className?: string };
export function Dialog({ open, title, onClose, children, busy, className = "" }: DialogProps) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const previous = document.activeElement;
    node.showModal();
    return () => {
      if (node.open) node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  return <dialog ref={ref} className={"mz-dialog " + className} aria-labelledby={id} aria-busy={busy || undefined}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    {open && <div className="mz-dialog-body"><header><h2 id={id}>{title}</h2>
      <IconButton icon="close" label="Закрыть" disabled={busy} onClick={onClose} /></header>{children}</div>}
  </dialog>;
}
export function ConfirmDialog({ confirmLabel, onConfirm, busy, ...props }: DialogProps & { confirmLabel: string; onConfirm: () => void }) {
  return <Dialog {...props} busy={busy}>{props.children}<div className="mz-actions">
    <Button variant="secondary" disabled={busy} onClick={props.onClose}>Отмена</Button>
    <Button variant="danger" loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
  </div></Dialog>;
}
export function Drawer(props: DialogProps) {
  return <Dialog {...props} className="mz-drawer" />;
}
export function Tooltip({ text, children }: { text: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return <span className="mz-tooltip">{children(id)}<span role="tooltip" id={id}>{text}</span></span>;
}
export function Toast({ children }: { children: ReactNode }) {
  return <div className="mz-toast" role="status">{children}</div>;
}
export function LoadingIndicator({ children = "Загрузка…" }: { children?: ReactNode }) {
  return <span role="status" className="mz-loading"><span className="mz-spinner" aria-hidden="true" />{children}</span>;
}
export function Skeleton() {
  return <div className="mz-skeleton"><LoadingIndicator /></div>;
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <Card className="mz-empty"><Icon name="layers" size={24} /><h2>{title}</h2>{children}</Card>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => unknown }) {
  return <div className="mz-error-state"><Icon name="warning" /><p role="alert">{message}</p>
    {retry && <Button variant="secondary" onClick={() => void retry()}>Обновить</Button>}</div>;
}
export function DataTable({ label, columns, children }: { label: string; columns: { id: string; label: ReactNode }[]; children: ReactNode }) {
  return <div className="mz-table-scroll" role="region" aria-label={label} tabIndex={0}><table>
    <thead><tr>{columns.map(column => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead><tbody>{children}</tbody>
  </table></div>;
}
export function Pagination({ onFirst, onNext }: { onFirst?: () => void; onNext?: () => void }) {
  if (!onFirst && !onNext) return null;
  return <nav aria-label="Страницы результатов" className="mz-actions mz-pagination">
    {onFirst && <Button variant="secondary" onClick={onFirst}><Icon name="back" size={16} />К началу</Button>}
    {onNext && <Button variant="secondary" onClick={onNext}>Следующая страница<Icon name="arrow" size={16} /></Button>}
  </nav>;
}
export function Breadcrumbs({ children }: { children: ReactNode }) {
  return <nav aria-label="Навигационная цепочка" className="mz-breadcrumbs">{children}</nav>;
}
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return <header className="mz-page-header"><div><h1 tabIndex={-1}>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="mz-actions">{actions}</div>}</header>;
}
export function DetailList({ items, className = "" }: { items: { label: string; value: ReactNode }[]; className?: string }) {
  return <dl className={"mz-detail-list " + className}>{items.map(item =>
    <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
export function Timeline({ children }: { children: ReactNode }) {
  return <ol className="mz-timeline">{children}</ol>;
}
export function CodeDisplay({ children }: { children: ReactNode }) {
  return <code className="mz-code">{children}</code>;
}
export function CopyField({ label, value }: { label: string; value: string }) {
  const [feedback, setFeedback] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback("Скопировано.");
    } catch {
      setFeedback("Выделите значение и скопируйте вручную.");
    }
  }
  return <div className="mz-copy"><FormField label={label}>{props => <Input {...props} readOnly value={value} />}</FormField>
    <Button variant="secondary" onClick={() => void copy()}>
      <Icon name="copy" size={16} />Копировать
    </Button>{feedback && <Toast>{feedback}</Toast>}</div>;
}
