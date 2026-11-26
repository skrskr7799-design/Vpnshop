import { zodResolver } from "@hookform/resolvers/zod";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@vpn/shared";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { Alert } from "../../../components/Alert/Alert";
import { AuthPage } from "../../../components/AuthPage/AuthPage";
import { Button } from "../../../components/Button/Button";
import { ButtonLink } from "../../../components/Button/ButtonLink";
import { Field } from "../../../components/Field/Field";
import { getErrorMessage } from "../errors";
import { useAuthCapabilities } from "../oauth";
import { useForgotPassword } from "../queries";

export function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const capability = useAuthCapabilities();
  const unavailable = capability.data?.emailAvailable === false || forgot.data?.emailAvailable === false;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: "" } });

  if (unavailable) return <AuthPage title="Сброс пароля" lead="Автоматический сброс по почте сейчас недоступен. Если вы подключили Google или Telegram, используйте этот способ входа.">
    <ButtonLink to="/login" variant="secondary">Вернуться ко входу</ButtonLink>
  </AuthPage>;

  if (forgot.isSuccess) {
    return (
      <AuthPage
        title="Проверьте почту"
        lead="Если у аккаунта есть подтверждённый адрес и сброс доступен, ссылка будет поставлена в очередь. Она действует 1 час."
      >
        <ButtonLink to="/login" variant="secondary">
          Вернуться ко входу
        </ButtonLink>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Сброс пароля" lead="Укажите email, и мы отправим ссылку для создания нового пароля.">
      <form className="auth-form" noValidate onSubmit={handleSubmit((values) => forgot.mutate(values))}>
        {forgot.isError && <Alert variant="error">{getErrorMessage(forgot.error)}</Alert>}
        <Field
          label="Электронная почта"
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          error={errors.email?.message}
          {...register("email")}
        />
        <Button type="submit" loading={forgot.isPending}>
          Отправить ссылку
        </Button>
      </form>
      <Link to="/login">Вернуться ко входу</Link>
    </AuthPage>
  );
}
