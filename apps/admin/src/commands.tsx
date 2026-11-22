import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { api, ApiError, errorText } from "./api";
import { useCan } from "./session";
import { Facts } from "./views";

export type Field = {
  name: string; label: string; type?: "number" | "email" | "textarea" | "checkbox";
  options?: string[]; value?: string | number; required?: boolean;
};
type Command = Record<string, string | number | boolean>;
type Envelope = {
  command: Command; expectedVersion: string; reason: string; confirmationId: string;
};
type Result = { commandId: string; result: Record<string, unknown>; invitationToken?: string };
export function Action({ title, operation, permission, target, version, fields = [], payload = {}, after }: {
  title: string; operation: string; permission: string; target: string | ((body: Command) => string);
  version: string | number; fields?: Field[]; payload?: Command; after?: () => unknown;
}) {
  const allowed = useCan(permission);
  const cache = useQueryClient();
  const [preview, setPreview] = useState<{ targetId: string; command: Command; expectedVersion: string; reason: string }>();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");
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
    setError("");
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
      setResult(response);
      await cache.invalidateQueries({ queryKey: ["admin"] });
      await after?.();
    } catch (cause) {
      if (cause instanceof ApiError && [400, 401, 403, 404, 409].includes(cause.status)) saved.current = null;
      setError(errorText(cause));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }
  return <details className="panel command" onToggle={event => { if (!event.currentTarget.open) setResult(undefined); }}>
    <summary>{title}</summary>
    {result && <div role="status"><p>Команда записана · {result.commandId}</p>
      {result.invitationToken && <p>Одноразовый код для защищённой передачи <code>{result.invitationToken}</code></p>}
      <Facts data={result.result} />
    </div>}
    {error && <p role="alert">{error}</p>}
    {!preview ? <form onSubmit={prepare}>
      {fields.map(field => <label key={field.name}>{field.label}
        {field.options ? <select name={field.name} defaultValue={field.value}>{field.required === false && <option value="">—</option>}
          {field.options.map(option => <option key={option}>{option}</option>)}</select>
          : field.type === "textarea" ? <textarea name={field.name} rows={3} maxLength={2000} required={field.required ?? true} />
          : <input name={field.name} type={field.type ?? "text"} defaultValue={field.value}
              required={field.type !== "checkbox" && (field.required ?? true)} />}
      </label>)}
      <label>Причина<textarea name="reason" minLength={5} maxLength={500} rows={2} required /></label>
      <button>Проверить команду</button>
    </form> : <>
      <p>Проверьте цель {preview.targetId} и версию {preview.expectedVersion}.</p>
      <Facts data={{ ...preview.command, reason: preview.reason }} />
      {saved.current ? <button onClick={() => void execute()} disabled={pending}>Повторить тот же запрос</button>
        : <form onSubmit={event => void execute(event)}>
          <label>Служебный пароль<input type="password" name="password" autoComplete="current-password" required /></label>
          <label>Свежий код TOTP<input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" required /></label>
          <button disabled={pending}>{pending ? "Подтверждаем…" : "Подтвердить и выполнить"}</button>
        </form>}
      <button type="button" disabled={pending} onClick={() => { saved.current = null; setPreview(undefined); setError(""); }}>Отмена</button>
    </>}
  </details>;
}
