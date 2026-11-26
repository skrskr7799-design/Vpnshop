import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useLocation } from "react-router";
import { Alert } from "../../../components/Alert/Alert";
import { AuthPage } from "../../../components/AuthPage/AuthPage";
import { Button } from "../../../components/Button/Button";
import { ButtonLink } from "../../../components/Button/ButtonLink";
import { PasswordField } from "../../../components/Field/PasswordField";
import { getErrorMessage, isInvalidToken } from "../errors";
import { useResetPassword } from "../queries";
import { resetFormSchema, type ResetForm } from "../schemas";

export function ResetPasswordPage() {
  const location = useLocation();
  // Токен читаем один раз и убираем из адресной строки
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? new URLSearchParams(location.search).get("token"));
  const reset = useResetPassword();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetForm>({
    resolver: zodResolver(resetFormSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  useEffect(() => {
    window.history.replaceState(window.history.state, "", location.pathname);
  }, [location.pathname]);

  if (reset.isSuccess) {
    return (
      <AuthPage
        title="Пароль изменён"
        lead="Войдите с новым паролем. На других устройствах вход нужно будет выполнить заново."
      >
        <ButtonLink to="/login">Войти</ButtonLink>
      </AuthPage>
    );
  }

  if (!token || isInvalidToken(reset.error)) {
    return (
      <AuthPage title="Ссылка не работает" lead="Она недействительна или устарела. Запросите новую.">
        <ButtonLink to="/forgot-password">Запросить ссылку</ButtonLink>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Новый пароль">
      <form
        className="auth-form"
        noValidate
        onSubmit={handleSubmit(({ password }) => reset.mutate({ token, password }))}
      >
        {reset.isError && <Alert variant="error">{getErrorMessage(reset.error)}</Alert>}
        <PasswordField
          label="Новый пароль"
          autoComplete="new-password"
          hint="Не короче 10 символов"
          error={errors.password?.message}
          {...register("password")}
        />
        <PasswordField
          label="Повторите пароль"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register("confirmPassword")}
        />
        <Button type="submit" loading={reset.isPending}>
          Сохранить пароль
        </Button>
      </form>
      <Link to="/login">Вернуться ко входу</Link>
    </AuthPage>
  );
}
