import { Button, Checkbox, CodeDisplay, Dialog, Input, PasswordInput, Select, StatusIndicator, Textarea } from "@vpn/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, ApiError, errorText } from "./api";
import { useCan } from "./session";
import { Facts, states } from "./views";

export type Field = {
  name: string; label: string; type?: "number" | "email" | "textarea" | "checkbox";
  options?: string[]; value?: string | number; required?: boolean;
};
type Command = Record<string, string | number | boolean>;
type Envelope = {
  command: Command; expectedVersion: string; reason: string; confirmationId: string;
};
type Result = { commandId: string; result: Record<string, unknown>; invitationToken?: string };
export function Action({ title, operation, permission, target, version, fields = [], payload = {}, baseline, after }: {
  title: string; operation: string; permission: string; target: string | ((body: Command) => string);
  version: string | number; fields?: Field[]; payload?: Command; baseline?: (command: Command) => Record<string, unknown> | undefined; after?: () => unknown;
}) {
  const allowed = useCan(permission);
  const cache = useQueryClient();
  const [preview, setPreview] = useState<{ targetId: string; command: Command; expectedVersion: string; reason: string }>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const saved = useRef<{ targetId: string; key: string; envelope: Envelope } | null>(null);
  if (!allowed) return null;
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const command = { ...payload };
    for (const field of fields) {
      const value = String(values.get(field.name) ?? "").trim();
      if (field.type === "checkbox") command[field.name] = values.has(field.name);
      else if (value) command[field.name] = field.type === "number" ? Number(value) : value;
    }
    setPreview({ targetId: typeof target === "function" ? target(command) : target,
      command, expectedVersion: String(version), reason: String(values.get("reason")).trim() });
    setResult(undefined);
    setPreviewOpen(true);
    setError("");
    setConflict(false);
  }
  async function execute(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!preview || sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    try {
      if (!saved.current) {
        if (!event) return;
        const values = new FormData(event.currentTarget);
        const { confirmationId } = await api<{ confirmationId: string }>("/auth/step-up", {
          method: "POST", body: { ...preview, operation, permission, password: values.get("password"), code: values.get("code") },
        });
        saved.current = {
          targetId: preview.targetId, key: crypto.randomUUID(),
          envelope: { reason: preview.reason, expectedVersion: preview.expectedVersion, command: preview.command, confirmationId },
        };
      }
      const { targetId, key, envelope } = saved.current;
      const response = await api<Result>(`/commands/${operation}/${encodeURIComponent(targetId)}`, {
        method: "POST", key, body: envelope,
      });
      saved.current = null;
      setPreview(undefined);
      setPreviewOpen(false);
      setResult(response);
      await cache.invalidateQueries({ queryKey: ["admin"] });
      await after?.();
    } catch (cause) {
      if (cause instanceof ApiError && [400, 401, 403, 404, 409].includes(cause.status)) saved.current = null;
      setConflict(cause instanceof ApiError && ["VERSION_CONFLICT", "CASE_CHANGED", "STALE_REVISION"].includes(cause.code));
      setError(errorText(cause));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  function closePreview() {
    setPreviewOpen(false);
    if (saved.current) return;
    setPreview(undefined);
    setConflict(false);
    setError("");
  }
  const prior = preview ? baseline?.(preview.command) : undefined;
  const waiting = result?.result.status === "WAITING_EXTERNAL" || result?.result.state === "WAITING_EXTERNAL";
  return <details className="panel command" onToggle={event => { if (!event.currentTarget.open) setResult(undefined); }}>
    <summary>{title}</summary>
    {result && <div role="status"><p>{waiting ? "Команда ожидает внешнего подтверждения" : "Команда записана"} · <CodeDisplay>{result.commandId}</CodeDisplay></p>
      {waiting && <StatusIndicator status="WAITING_EXTERNAL">{states.WAITING_EXTERNAL}</StatusIndicator>}
      {result.invitationToken && <p>Одноразовый код для защищённой передачи <CodeDisplay>{result.invitationToken}</CodeDisplay></p>}
      <Facts data={result.result} />
    </div>}
    {!previewOpen && saved.current ? <div className="mz-actions">
      <p className="admin-meta">Сервер пока не подтвердил исход команды.</p>
      <Button variant="secondary" onClick={() => setPreviewOpen(true)}>Вернуться к попытке</Button>
    </div> : <form onSubmit={prepare}>
      {fields.map(field => field.type === "checkbox" ? <Checkbox key={field.name} name={field.name}
        defaultChecked={field.value === "true"}>{field.label}</Checkbox> : <label key={field.name}>{field.label}
        {field.options ? <Select name={field.name} defaultValue={field.value}>{field.required === false && <option value="">—</option>}
          {field.options.map(option => <option key={option} value={option}>{states[option] ?? option}</option>)}</Select>
          : field.type === "textarea" ? <Textarea name={field.name} rows={3} maxLength={2000} required={field.required ?? true} />
          : <Input name={field.name} type={field.type ?? "text"} defaultValue={field.value} required={field.required ?? true} />}
      </label>)}
      <label>Причина<Textarea name="reason" minLength={5} maxLength={500} rows={2} required /></label>
      <Button type="submit" variant="secondary">Проверить команду</Button>
    </form>}
    <Dialog open={previewOpen} onClose={closePreview} title={title} busy={pending} className="command-confirm">
      {preview && <>
        <p>Объект <CodeDisplay>{preview.targetId}</CodeDisplay> · версия {preview.expectedVersion}</p>
        <div className={prior ? "command-comparison" : ""}>
          {prior && <section><h3>Текущая версия</h3><Facts data={prior} /></section>}
          <section><h3>{prior ? "Новая версия" : "Изменения"}</h3><Facts data={{ ...preview.command, reason: preview.reason }} /></section>
        </div>
        {error && <p role="alert">{error}</p>}
        {conflict ? <Button variant="secondary" onClick={() => { closePreview(); void cache.invalidateQueries({ queryKey: ["admin"] }); }}>Обновить объект</Button>
          : saved.current ? <Button loading={pending} onClick={() => void execute()}>Повторить тот же запрос</Button>
          : <form onSubmit={event => void execute(event)}>
            <label>Служебный пароль<PasswordInput name="password" autoComplete="current-password" required /></label>
            <label>Свежий код TOTP<Input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" required /></label>
            <div className="mz-actions">
              <Button variant="secondary" disabled={pending} onClick={closePreview}>Отмена</Button>
              <Button variant="danger" type="submit" loading={pending}>Подтвердить и выполнить</Button>
            </div>
          </form>}
      </>}
    </Dialog>
  </details>;
}
