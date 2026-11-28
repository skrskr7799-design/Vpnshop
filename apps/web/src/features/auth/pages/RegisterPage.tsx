import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { useProductConfig } from "../../../config";
import { ProductLinks } from "../../../components/ProductLinks";
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

export function RegisterPage({ initialEmail = "", onBack }: { initialEmail?: string; onBack?: () => void }) {
  const back = onBack
    ? <Button type="button" variant="secondary" onClick={onBack}>Вернуться ко входу</Button>
    : <ButtonLink to="/login" variant="secondary">Вернуться ко входу</ButtonLink>;
  const registration = useRegister();
  const availability = useProductConfig().data?.availability;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterForm>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: { email: initialEmail, password: "", confirmPassword: "" },
  });

  if (registration.isSuccess) {
    return (
      <AuthPage
        title="Заявка на регистрацию"
        lead={registration.data.emailAvailable === false
          ? "Автоматические письма недоступны. Обратитесь к оператору магазина для ручной активации."
          : "При регистрации по почте проверьте входящие. Для ручного подтверждения обратитесь к оператору."}
      >
        {registration.data.registrationReference && <p>При ручной проверке сообщите оператору номер заявки:
          {" "}<code>{registration.data.registrationReference}</code>.</p>}
        {registration.data.emailAvailable !== false &&
          <><p>Проверьте папку «Спам». Для созданного аккаунта <Link to="/activation">запросите подтверждение</Link>.</p><Button type="button" variant="secondary" onClick={() => registration.reset()}>Повторить регистрацию</Button></>}
        {back}
      </AuthPage>
    );
  }

  if (availability?.registration === false) return <AuthPage title="Регистрация закрыта"
    lead="Если у вас уже есть аккаунт, воспользуйтесь входом.">
    {back}<ProductLinks kind="support" />
  </AuthPage>;

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
      {!onBack && <OAuthButtons />}
      <ProductLinks kind="legal" />
      {back}
    </AuthPage>
  );
}
