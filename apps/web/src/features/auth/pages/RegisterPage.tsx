import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { Alert } from "../../../components/Alert/Alert";
import { AuthPage } from "../../../components/AuthPage/AuthPage";
import { Button } from "../../../components/Button/Button";
import { ButtonLink } from "../../../components/Button/ButtonLink";
import { Field } from "../../../components/Field/Field";
import { PasswordField } from "../../../components/Field/PasswordField";
import { OAuthButtons } from "../../../components/OAuthButtons/OAuthButtons";
import { getErrorMessage } from "../errors";
import { useRegister } from "../queries";
import { registerFormSchema, type RegisterForm } from "../schemas";

export function RegisterPage() {
  const registration = useRegister();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterForm>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { email: "", password: "", confirmPassword: "" },
  });

  if (registration.isSuccess) {
    return (
      <AuthPage
        title="Проверьте почту"
        lead={`Мы отправили письмо на ${registration.variables.email}. Откройте ссылку из него в течение 24 часов, чтобы завершить регистрацию.`}
      >
        <p>Письма нет? Посмотрите в папке «Спам» или зарегистрируйтесь ещё раз с тем же адресом.</p>
        <ButtonLink to="/login" variant="secondary">
          Вернуться ко входу
        </ButtonLink>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Создать аккаунт">
      <form
        className="auth-form"
        noValidate
        onSubmit={handleSubmit(({ email, password }) => registration.mutate({ email, password }))}
      >
        {registration.isError && <Alert variant="error">{getErrorMessage(registration.error)}</Alert>}
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
        <PasswordField
          label="Пароль"
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
        <Button type="submit" loading={registration.isPending}>
          Создать аккаунт
        </Button>
      </form>
      <OAuthButtons />
      <p>
        Уже есть аккаунт? <Link to="/login">Войти</Link>
      </p>
    </AuthPage>
  );
}
