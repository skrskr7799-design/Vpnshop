import { useMutation } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { Link } from "react-router";
import { Alert } from "../../../components/Alert/Alert";
import { AuthPage } from "../../../components/AuthPage/AuthPage";
import { Button } from "../../../components/Button/Button";
import { Field } from "../../../components/Field/Field";
import { authApi } from "../api";
import { getErrorMessage } from "../errors";
import { useAuthCapabilities } from "../oauth";

export function ActivationPage() {
  const status = useAuthCapabilities();
  const resend = useMutation({ mutationFn: authApi.resendVerification });
  const unavailable = status.data?.emailAvailable === false || resend.data?.emailAvailable === false;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email"));
    resend.mutate({ email });
  }

  return <AuthPage title="Подтверждение аккаунта" lead="Войдите после подтверждения адреса или ручной активации оператором магазина.">
    {unavailable ? <p>Автоматические письма сейчас недоступны. Обратитесь к оператору для ручной активации.</p> :
      <form className="auth-form" onSubmit={submit}>
        {resend.isSuccess && <p role="status">Если аккаунт существует и адрес ожидает подтверждения, письмо поставлено в очередь.</p>}
        {resend.isError && <Alert variant="error">{getErrorMessage(resend.error)}</Alert>}
        <Field label="Электронная почта" type="email" name="email" autoComplete="email" required />
        <Button type="submit" loading={resend.isPending}>Повторить запрос подтверждения</Button>
      </form>}
    <p><Link to="/register">Подать заявку на регистрацию</Link> · <Link to="/login">Вернуться ко входу</Link></p>
  </AuthPage>;
}
