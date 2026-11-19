import { OAUTH_PROVIDERS, type OAuthProviderId, type PublicUser } from "@vpn/shared";
import { Link } from "react-router";
import { Alert } from "../../../components/Alert/Alert";
import { Button } from "../../../components/Button/Button";
import { useConsumedSearchParam } from "../../../hooks/useConsumedSearchParam";
import { getMessageByCode } from "../errors";
import { connectProvider, OAUTH_LABELS, useLinkedProviders, useOAuthProviders } from "../oauth";
import "./LoginMethods.css";

// Блок «Способы входа» в аккаунте: что подключено и что можно добавить
export function LoginMethods({ user }: { user: PublicUser }) {
  const linked = useLinkedProviders();
  const enabled = useOAuthProviders();
  const justLinked = useConsumedSearchParam("linked");
  const errorCode = useConsumedSearchParam("error");

  if (linked.isPending || linked.isError) return null;
  const has = (provider: "EMAIL" | "GOOGLE" | "TELEGRAM") => linked.data.includes(provider);

  const justLinkedLabel = OAUTH_PROVIDERS.find((p) => p === justLinked);

  return (
    <section className="login-methods" aria-labelledby="login-methods-title">
      <h2 id="login-methods-title" className="login-methods__title">
        Способы входа
      </h2>
      {justLinkedLabel && <Alert variant="success">{OAUTH_LABELS[justLinkedLabel]} подключён.</Alert>}
      {errorCode && <Alert variant="error">{getMessageByCode(errorCode)}</Alert>}

      <ul className="login-methods__list">
        <Row name="Почта и пароль">
          {has("EMAIL") ? (
            <Status />
          ) : user.email ? (
            // Пароль можно задать через сброс: ссылка подтверждает владение почтой
            <Link to="/forgot-password">Задать пароль</Link>
          ) : (
            <span className="login-methods__muted">Не подключено</span>
          )}
        </Row>
        {OAUTH_PROVIDERS.filter((provider) => enabled.data?.[provider]).map((provider) => (
          <Row key={provider} name={OAUTH_LABELS[provider]}>
            {has(provider.toUpperCase() as "GOOGLE" | "TELEGRAM") ? (
              <Status />
            ) : (
              <Connect provider={provider} />
            )}
          </Row>
        ))}
      </ul>
    </section>
  );
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <li className="login-methods__row">
      <span className="login-methods__name">{name}</span>
      {children}
    </li>
  );
}

const Status = () => <span className="login-methods__status">Подключено</span>;

function Connect({ provider }: { provider: OAuthProviderId }) {
  return (
    <Button variant="secondary" block={false} onClick={() => void connectProvider(provider)}>
      Подключить
    </Button>
  );
}
