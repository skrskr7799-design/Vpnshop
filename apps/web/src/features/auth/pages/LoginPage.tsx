import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput } from "@vpn/shared";
import { useForm } from "react-hook-form";
import { Link, useLocation } from "react-router";
import { useProductConfig } from "../../../config";
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
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLogin } from "../queries";
import { getRedirectTarget } from "../redirect";
import { Icon, MazeOpening } from "@vpn/ui";
import { playEntry, readEntryMethod } from "../entry";
import { RegisterPage } from "./RegisterPage";

export function LoginPage() {
  const [opening, setOpening] = useState(false);
  const openingController = useRef<AbortController>(null);
  useEffect(() => () => openingController.current?.abort(), []);
  const login = useLogin(async () => {
    const controller = new AbortController();
    openingController.current = controller;
    await playEntry(() => setOpening(true), controller.signal);
  });
  const [stage, setStage] = useState<"email" | "password" | "register">("email");
  const availability = useProductConfig().data?.availability;
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
    trigger,
    resetField,
    setFocus,
    formState: { errors },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });

  useEffect(() => {
    if (stage === "password") setFocus("password");
  }, [stage, setFocus]);

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

  if (opening) return <MazeOpening />;
  if (stage === "register") return <RegisterPage initialEmail={getValues("email")} onBack={() => setStage("password")} />;

  const emailFirst = readEntryMethod() === "email";
  const providers = !temporary && !logoutPending && stage === "email" &&
    <OAuthButtons returnTo={returnTo === "/account" ? undefined : returnTo} placement={emailFirst ? "below" : "above"} />;
  return (
    <AuthPage title={temporary ? "Смена временного пароля" : "Войти в кабинет"}>
      {!emailFirst && providers}
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
      <form className="auth-form auth-form--signin" noValidate onSubmit={event => {
        event.preventDefault();
        if (login.isPending || logoutPending) return;
        if (stage === "email") {
          void trigger("email", { shouldFocus: true }).then(valid => { if (valid) setStage("password"); });
          return;
        }
        void handleSubmit(values => login.mutate(values, {
          onError: error => { if (error instanceof ApiError && error.code === "TEMPORARY_PASSWORD") setTemporary(true); },
        }))(event);
      }}>
        {login.isError && <p className="auth-signin-error" role="alert">{getErrorMessage(login.error)}</p>}
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
          readOnly={stage === "password"}
          error={errors.email?.message}
          {...register("email")}
        />
        {stage === "password" && <>
        <div className="auth-recovery"><button type="button" className="auth-text-button" disabled={login.isPending} onClick={() => {
          resetField("password"); login.reset(); setStage("email"); requestAnimationFrame(() => setFocus("email"));
        }}>Изменить почту</button></div>
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
        </>}
        <Button type="submit" disabled={logoutPending} loading={login.isPending}>
          {stage === "email" ? "Продолжить" : "Войти"} <Icon name="arrow" size={17} />
        </Button>
      </form>
      {stage === "password" && <Button type="button" variant="secondary" disabled={login.isPending} onClick={() => {
        setMessage(undefined); setTemporary(true);
      }}>У меня временный пароль</Button>}
      </>}
      {emailFirst && providers}
      {availability?.maintenance && <p><Link to="/maintenance">Техническое обслуживание</Link></p>}
      {!temporary && (availability?.registration === false ? <p>Новая регистрация закрыта.</p> :
        stage === "password" && <p className="auth-links auth-links--register">Нет аккаунта?{" "}
          <button type="button" className="auth-text-button" disabled={login.isPending} onClick={() => {
            resetField("password"); login.reset(); setStage("register");
          }}>Зарегистрироваться</button>
        </p>)}
    </AuthPage>
  );
}
