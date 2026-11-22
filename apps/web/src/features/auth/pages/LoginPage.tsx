import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@vpn/shared";
import { useForm } from "react-hook-form";
import { Link, useLocation } from "react-router";
import { Alert } from "../../../components/Alert/Alert";
import { AuthPage } from "../../../components/AuthPage/AuthPage";
import { Button } from "../../../components/Button/Button";
import { Field } from "../../../components/Field/Field";
import { OAuthButtons } from "../../../components/OAuthButtons/OAuthButtons";
import { useConsumedSearchParam } from "../../../hooks/useConsumedSearchParam";
import { PasswordField } from "../../../components/Field/PasswordField";
import { getErrorMessage, getMessageByCode } from "../errors";
import { authApi, logoutHidden, publishSessionEvent, setLogoutHidden } from "../api";
import { useState } from "react";
import { useLogin } from "../queries";
import { getRedirectTarget } from "../redirect";

export function LoginPage() {
  const login = useLogin();
  const [logoutPending, setLogoutPending] = useState(logoutHidden);
  const location = useLocation();
  // Ошибка внешнего входа приходит в адресной строке: /login?error=OAUTH_DENIED
  const oauthError = useConsumedSearchParam("error");
  const returnTo = getRedirectTarget(location.state);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });

  return (
    <AuthPage title="Вход" lead="Войдите, чтобы управлять подпиской и подключениями.">
      {logoutPending && <Alert variant="error">
        Данные скрыты. Серверный выход ещё не подтверждён.
        <button type="button" onClick={() => void authApi.logout().then(() => {
          setLogoutHidden(false); setLogoutPending(false); publishSessionEvent("logout-confirmed");
        }).catch(() => {})}>Повторить выход</button>
      </Alert>}
      <form className="auth-form" noValidate onSubmit={handleSubmit((values) => login.mutate(values))}>
        {login.isError && <Alert variant="error">{getErrorMessage(login.error)}</Alert>}
        {!login.isError && oauthError && <Alert variant="error">{getMessageByCode(oauthError)}</Alert>}
        <Field
          label="Электронная почта"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          error={errors.email?.message}
          {...register("email")}
        />
        <PasswordField
          label="Пароль"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register("password")}
        />
        <Button type="submit" loading={login.isPending}>
          Войти
        </Button>
      </form>
      {!logoutPending && <OAuthButtons returnTo={returnTo === "/account" ? undefined : returnTo} />}
      <div className="auth-links">
        <Link to="/forgot-password">Забыли пароль?</Link>
        <Link to="/register">Создать аккаунт</Link>
      </div>
    </AuthPage>
  );
}
