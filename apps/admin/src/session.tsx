import { createContext, useContext, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { api, errorText } from "./api";

export type Principal = { user: { id: string; email: string; role: "ADMIN" | "SUPPORT" }; permissions: string[] };
export const Session = createContext<Principal | null>(null);
export const useSession = () => useContext(Session);
export const useCan = (permission: string) => useSession()?.permissions.includes(permission) ?? false;

export function Login({ invitation = false }: { invitation?: boolean }) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [stage, setStage] = useState<{ step: string; token: string; secret?: string }>();
  const [recoveryCodes, setCodes] = useState<string[]>([]);
  const [issue, setIssue] = useState("");
  const [pending, setPending] = useState(false);
  const [recover, setRecover] = useState(false);
  async function entered() {
    cache.removeQueries({ predicate: query => query.queryKey[0] !== "admin-me" });
    cache.setQueryData(["admin-me"], await api<Principal>("/me"));
    navigate("/", { replace: true });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields = new FormData(event.currentTarget);
    setPending(true); setIssue("");
    try {
      if (invitation) {
        await api("/auth/invitations/accept", { method: "POST", body: { token: fields.get("token"), password: fields.get("password") } });
        navigate("/login", { replace: true });
      } else if (!stage) {
        const result = await api<{ step: string; stageToken: string }>("/auth/login", {
          method: "POST", body: { email: fields.get("email"), password: fields.get("password") },
        });
        const setup = result.step === "enroll_2fa" ? await api<{ secret: string }>("/auth/2fa/enroll/start", {
          method: "POST", body: { stageToken: result.stageToken },
        }) : undefined;
        setStage({ step: result.step, token: result.stageToken, secret: setup?.secret });
      } else {
        const code = String(fields.get("code")).trim();
        const result = await api<{ recoveryCodes?: string[] }>(stage.secret ? "/auth/2fa/enroll/confirm" : "/auth/2fa/verify", {
          method: "POST", body: { stageToken: stage.token, ...(recover ? { recoveryCode: code } : { code }) },
        });
        setStage(undefined);
        if (result.recoveryCodes?.length) setCodes(result.recoveryCodes);
        else await entered();
      }
    } catch (error) { setIssue(errorText(error)); }
    finally { setPending(false); }
  }
  return <main className="login"><section className="panel">
    <p className="brand">MZT</p>
    <h1>{invitation ? "Приглашение" : "Вход для сотрудников"}</h1>
    {issue && <p role="alert">{issue}</p>}
    {recoveryCodes.length > 0 ? <><h2>Резервные коды</h2>
      <p>Сохраните коды отдельно от пароля. Они показаны один раз.</p>
      <ul className="codes">{recoveryCodes.map(code => <li key={code}><code>{code}</code></li>)}</ul>
      <button onClick={() => { setCodes([]); void entered(); }}>Коды сохранены</button>
    </> : <form onSubmit={event => void submit(event)} key={stage?.token ?? "login"}>
      {invitation ? <label>Код приглашения<input name="token" required autoComplete="off" /></label> : !stage &&
        <label>Служебный email<input name="email" type="email" required autoComplete="username" /></label>}
      {!stage && <label>Пароль<input name="password" type="password" required autoComplete={invitation ? "new-password" : "current-password"} /></label>}
      {stage?.secret && <p>Добавьте ключ в приложение-аутентификатор. <code>{stage.secret}</code></p>}
      {stage && <label>{recover ? "Резервный код" : "Код приложения"}<input name="code" required autoComplete="one-time-code"
        inputMode={recover ? "text" : "numeric"} pattern={recover ? undefined : "[0-9]{6}"} /></label>}
      <button disabled={pending}>{pending ? "Проверяем…" : stage ? "Подтвердить" : invitation ? "Активировать" : "Продолжить"}</button>
      {stage && <div className="actions">
        {!stage.secret && <button type="button" onClick={() => setRecover(!recover)}>{recover ? "Код приложения" : "Использовать резервный код"}</button>}
        <button type="button" onClick={() => { setStage(undefined); setRecover(false); }}>Начать заново</button>
      </div>}
    </form>}
    {!stage && !recoveryCodes.length && <Link to={invitation ? "/login" : "/invitation"}>{invitation ? "Ко входу" : "У меня есть приглашение"}</Link>}
  </section></main>;
}
