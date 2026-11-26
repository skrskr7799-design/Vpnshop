import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@vpn/shared";
import { useForm } from "react-hook-form";
import { Link, useLocation } from "react-router";
import { Alert } from "../../../components/Alert/Alert";
import { AuthPage } from "../../../components/AuthPage/AuthPage";
import { Button } from "../../../components/Button/Button";
import { Field } from "../../../components/Field/Field";
import { OAuthButtons } from "../../../components/OAuthButtons/OAuthButtons";
import { ApiError } from "../../../api/ApiError";
import { useConsumedSearchParam } from "../../../hooks/useConsumedSearchParam";
import { PasswordField } from "../../../components/Field/PasswordField";
import { getErrorMessage, getMessageByCode } from "../errors";
import { authApi, logoutHidden, publishSessionEvent, setLogoutHidden } from "../api";
import { useState, type FormEvent } from "react";
import { useLogin } from "../queries";
import { getRedirectTarget } from "../redirect";
import { Icon } from "@vpn/ui";

export function LoginPage() {
  const login = useLogin();
  const [temporary, setTemporary] = useState(false);
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const [logoutPending, setLogoutPending] = useState(logoutHidden);
  const location = useLocation();
  // Ошибка внешнего входа приходит в адресной строке: /login?error=OAUTH_DENIED
  const oauthError = useConsumedSearchParam("error");
  const returnTo = getRedirectTarget(location.state);
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changing) return;
    const fields = new FormData(event.currentTarget);
    const password = String(fields.get("password"));
    if (password !== fields.get("confirm")) { setMessage({ text: "Пароли не совпадают.", error: true }); return; }
    setChanging(true);
    setMessage(undefined);
    try {
      await authApi.changeTemporaryPassword({ email: String(fields.get("email")),
        temporaryPassword: String(fields.get("temporaryPassword")), password });
      login.reset();
      setTemporary(false);
      setMessage({ text: "Пароль изменён. Теперь войдите с новым паролем.", error: false });
    } catch (error) {
      setMessage({ text: getErrorMessage(error), error: true });
    } finally { setChanging(false); }
  }

  return (
    <AuthPage title="Добро пожаловать" lead="Войдите в свой аккаунт, чтобы продолжить.">
      {logoutPending && <Alert variant="error">
        Данные скрыты. Серверный выход ещё не подтверждён.
        <Button type="button" variant="secondary" onClick={() => void authApi.logout().then(() => {
          setLogoutHidden(false); setLogoutPending(false); publishSessionEvent("logout-confirmed");
        }).catch(() => {})}>Повторить выход</Button>
      </Alert>}
      {message && <p role={message.error ? "alert" : "status"}>{message.text}</p>}
      {temporary ? <form className="auth-form" onSubmit={event => void changePassword(event)}>
        <Field label="Электронная почта" name="email" type="email" autoComplete="username" defaultValue={getValues("email")} required />
        <PasswordField label="Временный пароль" name="temporaryPassword" autoComplete="current-password" minLength={12} maxLength={128} required />
        <PasswordField label="Новый пароль" name="password" autoComplete="new-password" minLength={12} maxLength={128} required />
        <PasswordField label="Повторите пароль" name="confirm" autoComplete="new-password" minLength={12} maxLength={128} required />
        <Button type="submit" loading={changing}>Сменить пароль</Button>
        <Button type="button" variant="secondary" disabled={changing} onClick={() => { setTemporary(false); setMessage(undefined); }}>Ко входу</Button>
      </form> : <>
      <form className="auth-form auth-form--signin" noValidate onSubmit={handleSubmit(values => login.mutate(values, {
        onError: error => { if (error instanceof ApiError && error.code === "TEMPORARY_PASSWORD") setTemporary(true); },
      }))}>
        {login.isError && <Alert variant="error">{getErrorMessage(login.error)}</Alert>}
        {!login.isError && oauthError && <Alert variant="error">{getMessageByCode(oauthError)}</Alert>}
        <Field
          label="Электронная почта"
          icon="mail"
          placeholder=" "
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
          icon="lock"
          placeholder=" "
          autoComplete="current-password"
          error={errors.password?.message}
          {...register("password")}
        />
        <div className="auth-recovery"><Link to="/forgot-password">Забыли пароль?</Link></div>
        {login.isError && getErrorMessage(login.error) === getMessageByCode("ACTIVATION_PENDING") &&
          <Link to="/activation">Подтверждение и активация</Link>}
        <Button type="submit" loading={login.isPending}>Войти <Icon name="arrow" size={17} /></Button>
      </form>
      <Button type="button" variant="secondary" onClick={() => { setMessage(undefined); setTemporary(true); }}>У меня временный пароль</Button>
      </>}
      {!temporary && !logoutPending && <OAuthButtons returnTo={returnTo === "/account" ? undefined : returnTo} />}
      <p className="auth-links auth-links--register">Нет аккаунта? <Link to="/register">Зарегистрироваться</Link></p>
    </AuthPage>
  );
}
