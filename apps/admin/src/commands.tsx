import { Button, Checkbox, CodeDisplay, Dialog, Input, PasswordInput, Select, StatusIndicator, Textarea } from "@vpn/ui";
import { adminCommandPolicy } from "@vpn/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, ApiError, errorText } from "./api";
import { useCan, useSession } from "./session";
import { Facts, states } from "./views";

export type Field = {
  name: string; label: string; type?: "number" | "email" | "textarea" | "checkbox" | "password";
  options?: readonly (string | { value: string; label: string })[]; value?: string | number; required?: boolean; clearable?: boolean;
};
type Command = Record<string, string | number | boolean | null>;
type Envelope = {
  command: Command; expectedVersion: string; reason?: string; confirmationId?: string;
};
type Preview = Omit<Envelope, "confirmationId"> & { targetId: string };
export type Result = { commandId: string; result: Record<string, unknown>; invitationToken?: string; stageToken?: string };
export function Action({ title, operation, permission, target, version, fields = [], payload = {}, baseline, after, context }: {
  title: string; operation: string; permission: string; target: string | ((body: Command) => string);
  version: string | number; fields?: Field[]; payload?: Command; baseline?: (command: Command) => Record<string, unknown> | undefined; after?: (response: Result) => unknown; context?: string;
}) {
  const allowed = useCan(permission);
  const policy = adminCommandPolicy(operation, payload);
  const needsCode = useSession()?.security?.requiresTotp ?? true;
  const cache = useQueryClient();
  const [preview, setPreview] = useState<Preview>();
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
      const raw = String(values.get(field.name) ?? "");
      const value = field.type === "password" ? raw : raw.trim();
      if (field.type === "checkbox") command[field.name] = values.has(field.name);
      else if (value) command[field.name] = field.type === "number" ? Number(value) : value;
      else if (field.clearable) command[field.name] = null;
    }
    for (const field of fields.filter(field => field.type === "password")) {
      const control = event.currentTarget.elements.namedItem(field.name);
      if (control instanceof HTMLInputElement) control.value = "";
    }
    const prepared = { targetId: typeof target === "function" ? target(command) : target,
      command, expectedVersion: String(version), ...(policy.reason && { reason: String(values.get("reason") ?? "").trim() }) };
    setPreview(prepared);
    setResult(undefined);
    setError("");
    setConflict(false);
    if (policy.stepUp) setPreviewOpen(true);
    else void execute(prepared);
  }
  async function execute(prepared = preview, event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!prepared || sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    try {
      if (!saved.current) {
        const { targetId, ...envelope } = prepared;
        if (policy.stepUp) {
          if (!event) return;
          const values = new FormData(event.currentTarget);
          const { confirmationId } = await api<{ confirmationId: string }>("/auth/step-up", {
            method: "POST", body: { ...prepared, operation, permission, password: values.get("password"), ...(needsCode && { code: values.get("code") }) },
          });
          saved.current = { targetId, key: crypto.randomUUID(), envelope: { ...envelope, confirmationId } };
        } else {
          saved.current = { targetId, key: crypto.randomUUID(), envelope };
        }
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
      await after?.(response);
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
  return <details className="mz-card panel command" onToggle={event => { if (!event.currentTarget.open) setResult(undefined); }}>
    <summary>{title}</summary>
    {result && <div role="status"><p>{waiting ? "Команда ожидает внешнего подтверждения" : "Команда записана"} · <CodeDisplay>{result.commandId}</CodeDisplay></p>
      {waiting && <StatusIndicator status="WAITING_EXTERNAL">{states.WAITING_EXTERNAL}</StatusIndicator>}
      {result.invitationToken && <p>Одноразовый код для защищённой передачи <CodeDisplay>{result.invitationToken}</CodeDisplay></p>}
      <Facts data={result.result} />
    </div>}
    {!previewOpen && error && <p role="alert">{error}</p>}
    {!previewOpen && saved.current ? <div className="mz-actions">
      <p className="admin-meta">Сервер пока не подтвердил исход команды.</p>
      <Button variant="secondary" loading={pending} onClick={() => policy.stepUp ? setPreviewOpen(true) : void execute()}>
        {policy.stepUp ? "Вернуться к попытке" : "Повторить тот же запрос"}</Button>
    </div> : <form onSubmit={prepare}>
      {fields.map(field => field.type === "checkbox" ? <Checkbox key={field.name} name={field.name}
        defaultChecked={field.value === "true"}>{field.label}</Checkbox> : <label key={field.name}>{field.label}
        {field.options ? <Select name={field.name} defaultValue={field.value}>{field.required === false && <option value="">—</option>}
          {field.options.map(option => typeof option === "string" ? <option key={option} value={option}>{states[option] ?? option}</option> :
            <option key={option.value} value={option.value}>{option.label}</option>)}</Select>
          : field.type === "textarea" ? <Textarea name={field.name} rows={3} maxLength={2000} required={field.required ?? true} />
          : field.type === "password" ? <PasswordInput name={field.name} minLength={12} maxLength={128} autoComplete="new-password" required={field.required ?? true} />
          : <Input name={field.name} type={field.type ?? "text"} defaultValue={field.value} required={field.required ?? true} />}
      </label>)}
      {policy.reason && <label>Причина<Textarea name="reason" minLength={5} maxLength={500} rows={2} required /></label>}
      <Button type="submit" variant="secondary" loading={pending}>{policy.stepUp ? "Проверить команду" : title}</Button>
    </form>}
    <Dialog open={previewOpen} onClose={closePreview} title={title} busy={pending} className="command-confirm">
      {preview && <>
        <p>Объект <CodeDisplay>{context ?? preview.targetId}</CodeDisplay> · версия {preview.expectedVersion}</p>
        <div className={prior ? "command-comparison" : ""}>
          {prior && <section className="mz-card"><h3>Текущая версия</h3><Facts data={prior} /></section>}
          <section className={prior ? "mz-card" : undefined}><h3>{prior ? "Новая версия" : "Изменения"}</h3><Facts data={{ ...Object.fromEntries(Object.entries(preview.command).filter(([key]) => !fields.some(field => field.name === key && field.type === "password"))), ...(preview.reason && { reason: preview.reason }) }} /></section>
        </div>
        {error && <p role="alert">{error}</p>}
        {conflict ? <Button variant="secondary" onClick={() => { closePreview(); void cache.invalidateQueries({ queryKey: ["admin"] }); }}>Обновить объект</Button>
          : saved.current ? <Button loading={pending} onClick={() => void execute()}>Повторить тот же запрос</Button>
          : <form onSubmit={event => void execute(preview, event)}>
            <label>Служебный пароль<PasswordInput name="password" autoComplete="current-password" required /></label>
            {needsCode && <label>Свежий код TOTP<Input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" required /></label>}
            <div className="mz-actions">
              <Button variant="secondary" disabled={pending} onClick={closePreview}>Отмена</Button>
              <Button variant="danger" type="submit" loading={pending}>Подтвердить и выполнить</Button>
            </div>
          </form>}
      </>}
    </Dialog>
  </details>;
}
