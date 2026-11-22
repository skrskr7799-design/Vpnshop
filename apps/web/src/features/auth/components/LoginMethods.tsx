import { useQuery } from "@tanstack/react-query";
import type { AuthProvider } from "@vpn/shared";
import { useState, type FormEvent } from "react";
import { request } from "../../../api/client";
import { useConsumedSearchParam } from "../../../hooks/useConsumedSearchParam";
import { useOAuthProviders } from "../oauth";
import { useMe } from "../queries";
import "./LoginMethods.css";

const labels: Record<AuthProvider, string> = { EMAIL: "Почта и пароль", GOOGLE: "Google", TELEGRAM: "Telegram" };
type Method = { provider: AuthProvider; usable: boolean; canUnlink: boolean; verified: boolean };
type Purpose = "LINK" | "UNLINK";
type Proof = { id: string; target: AuthProvider; purpose: Purpose };

export function LoginMethods() {
  const { data: user } = useMe();
  const scope = ["owner", user?.id, user?.sessionId] as const;
  const enabled = useOAuthProviders();
  const methods = useQuery({ queryKey: [...scope, "identities"], queryFn: ({ signal }) =>
    request<{ identities: Method[] }>("/auth/oauth/identities", { signal }), retry: false });
  const proofs = useQuery({ queryKey: [...scope, "proofs"], queryFn: ({ signal }) =>
    request<{ confirmations: Proof[] }>("/auth/oauth/reauth", { signal }), retry: false });
  const [action, setAction] = useState<{ target: AuthProvider; purpose: Purpose } | null>(null);
  const [method, setMethod] = useState<AuthProvider>("EMAIL");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const outcome = useConsumedSearchParam("error");
  const linked = useConsumedSearchParam("linked");
  const usable = methods.data?.identities.filter(identity => identity.usable) ?? [];

  const reauthMethods = action?.purpose === "UNLINK" ? usable.filter(entry => entry.provider !== action.target) : usable;

  async function apply(proof: Proof) {
    if (proof.purpose === "LINK") {
      const result = await request<{ authorizeUrl: string }>(`/auth/oauth/${proof.target.toLowerCase()}/link`, {
        method: "POST", body: { confirmationId: proof.id }, idempotencyKey: crypto.randomUUID(),
      });
      window.location.assign(result.authorizeUrl);
    } else {
      await request(`/auth/oauth/identities/${proof.target}`, { method: "DELETE", body: { confirmationId: proof.id } });
      setAction(null);
      await Promise.all([methods.refetch(), proofs.refetch()]);
    }
  }

  async function execute(command: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await command(); }
    catch { setError("Действие не завершилось. Обновите страницу или подтвердите вход ещё раз."); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = data.get("password");
    void execute(async () => {
      if (!action) return;
      const result = await request<{ confirmationId?: string; authorizeUrl?: string }>("/auth/oauth/reauth", {
        method: "POST", body: { ...action, method, ...(method === "EMAIL" && { password }) },
      });
      if (result.authorizeUrl) window.location.assign(result.authorizeUrl);
      else if (result.confirmationId) await apply({ ...action, id: result.confirmationId });
    });
  }

  return <section aria-labelledby="methods-title">
    <h2 id="methods-title">Способы входа</h2>
    {linked && <p role="status">Способ входа подключён.</p>}
    {(error || outcome) && <p role="alert">{error || "Подтверждение способа входа не завершилось."}</p>}
    {methods.isPending && <p>Загружаем способы входа…</p>}
    {methods.isError && <p role="alert">Не удалось прочитать способы входа.</p>}
    <ul className="login-methods__list">
      {methods.data?.identities.map(identity => <li className="login-methods__row" key={identity.provider}>
        <span>{labels[identity.provider]} · {identity.usable ? "доступен" : "ожидает проверки"}</span>
        {identity.canUnlink && <button type="button" onClick={() => {
          setAction({ target: identity.provider, purpose: "UNLINK" }); setMethod(usable.find(entry => entry.provider !== identity.provider)?.provider ?? "EMAIL");
        }}>Отключить</button>}
      </li>)}
    </ul>
    {(["google", "telegram"] as const).filter(provider => enabled.data?.[provider] &&
      !methods.data?.identities.some(identity => identity.provider.toLowerCase() === provider)).map(provider =>
      <button key={provider} type="button" disabled={!usable.length} onClick={() => {
        setAction({ target: provider.toUpperCase() as AuthProvider, purpose: "LINK" });
        setMethod(usable[0]?.provider ?? "EMAIL");
      }}>Подключить {labels[provider === "google" ? "GOOGLE" : "TELEGRAM"]}</button>)}
    {proofs.data?.confirmations.map(proof => <p key={proof.id}>
      <button disabled={busy} type="button" onClick={() => void execute(() => apply(proof))}>
        Подтвердить {proof.purpose === "LINK" ? "подключение" : "отключение"} {labels[proof.target]}
      </button>
    </p>)}
    {action && <form onSubmit={submit}>
      <p>{action.purpose === "LINK" ? "Подключение" : "Отключение"} {labels[action.target]}</p>
      <label>Подтвердите вход <select value={method} onChange={event => setMethod(event.target.value as AuthProvider)}>
        {reauthMethods.map(identity => <option key={identity.provider} value={identity.provider}>{labels[identity.provider]}</option>)}
      </select></label>
      {method === "EMAIL" && <label>Текущий пароль <input name="password" autoComplete="current-password" type="password" required /></label>}
      <button type="submit" disabled={busy}>Продолжить</button>{" "}
      <button type="button" onClick={() => setAction(null)}>Отмена</button>
    </form>}
  </section>;
}
