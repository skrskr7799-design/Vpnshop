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
import { useForgotPassword } from "../queries";

export function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: "" } });

  if (forgot.isSuccess) {
    return (
      <AuthPage
        title="Проверьте почту"
        lead={`Если аккаунт с адресом ${forgot.variables.email} существует, мы отправили на него ссылку для сброса пароля. Она действует 1 час.`}
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
          label="Email"
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
