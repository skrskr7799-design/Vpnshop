import { BrandMark, Button, CodeDisplay, Icon, Input, SignatureScene } from "@vpn/ui";
import { createContext, useContext, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { api, errorText } from "./api";

export type Principal = {
  user: { id: string; username: string; email: string | null; role: "OWNER" | "ADMIN" | "SUPPORT" };
  security: { policy: "required" | "optional" | "disabled"; requiresTotp: boolean; enrolled: boolean; version: number };
  permissions: string[];
};
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
  async function advance(result: { step: string; stageToken?: string }) {
    if (result.step === "authenticated") {
      await entered();
      return;
    }
    if (!result.stageToken) throw new Error("Missing login stage");
    const setup = result.step === "enroll_2fa" ? await api<{ secret: string }>("/auth/2fa/enroll/start", {
      method: "POST", body: { stageToken: result.stageToken },
    }) : undefined;
    setStage({ step: result.step, token: result.stageToken, secret: setup?.secret });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const fields = new FormData(event.currentTarget);
    setPending(true); setIssue("");
    try {
      if (invitation) {
        await api("/auth/invitations/accept", { method: "POST", body: { token: fields.get("token"), username: fields.get("username"), password: fields.get("password") } });
        navigate("/login", { replace: true });
      } else if (!stage) {
        await advance(await api("/auth/login", {
          method: "POST", body: { username: fields.get("username"), password: fields.get("password") },
        }));
      } else if (stage.step === "change_password") {
        if (fields.get("password") !== fields.get("confirm")) { setIssue("Пароли не совпадают."); return; }
        await advance(await api("/auth/password/change-temporary", {
          method: "POST", body: { stageToken: stage.token, password: fields.get("password") },
        }));
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
  const changing = stage?.step === "change_password";
  return <SignatureScene brand={<BrandMark />}>
    <section className="admin-signin">
    <h1>{invitation ? "Приглашение" : changing ? "Задайте новый пароль" : stage ? "Подтвердите вход" : "Вход для сотрудников"}</h1>
    {!stage && !recoveryCodes.length && <p className="login__context">{invitation ?
      "Используйте код, полученный от администратора." : "Используйте имя пользователя своей служебной учётной записи."}</p>}
    {issue && <p role="alert">{issue}</p>}
    {recoveryCodes.length > 0 ? <><h2>Резервные коды</h2>
      <p>Сохраните коды отдельно от пароля. Они показаны один раз.</p>
      <ul className="codes">{recoveryCodes.map(code => <li key={code}><CodeDisplay>{code}</CodeDisplay></li>)}</ul>
      <Button onClick={() => { setCodes([]); void entered(); }}>Коды сохранены</Button>
    </> : <form onSubmit={event => void submit(event)} key={stage?.token ?? "login"}>
      {invitation && <label>Код приглашения<Input name="token" required autoComplete="off" /></label>}
      {!stage && <label>Имя пользователя<span className="mz-input-icon"><Icon name="users" size={19} />
        <Input name="username" required minLength={3} maxLength={48} pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,47}"
          autoComplete="username" autoCapitalize="none" spellCheck={false} /></span></label>}
      {(!stage || changing) && <label>{changing ? "Новый пароль" : "Пароль"}<span className="mz-input-icon"><Icon name="lock" size={19} />
        <Input name="password" type="password" required minLength={changing || invitation ? 12 : undefined} maxLength={128}
          autoComplete={invitation || changing ? "new-password" : "current-password"} /></span></label>}
      {changing && <label>Повторите пароль<Input name="confirm" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>}
      {stage?.secret && <p>Добавьте ключ в приложение-аутентификатор. <CodeDisplay>{stage.secret}</CodeDisplay></p>}
      {stage && !changing && <label>{recover ? "Резервный код" : "Код приложения"}<Input name="code" required autoComplete="one-time-code"
        inputMode={recover ? "text" : "numeric"} pattern={recover ? undefined : "[0-9]{6}"} /></label>}
      <Button type="submit" loading={pending}>{changing ? "Сменить пароль" : stage ? "Подтвердить" : invitation ? "Активировать" : "Продолжить"}</Button>
      {stage && <div className="actions">
        {!stage.secret && !changing && <Button variant="secondary" onClick={() => setRecover(!recover)}>{recover ? "Код приложения" : "Использовать резервный код"}</Button>}
        <Button variant="quiet" onClick={() => { setStage(undefined); setRecover(false); }}>Начать заново</Button>
      </div>}
    </form>}
    {!stage && !recoveryCodes.length && <Link to={invitation ? "/login" : "/invitation"}>{invitation ? "Ко входу" : "У меня есть приглашение"}</Link>}
  </section></SignatureScene>;
}
