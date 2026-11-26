import { useEffect, useRef } from "react";
import { ApiError } from "../../../api/ApiError";
import { useConsumedSearchParam } from "../../../hooks/useConsumedSearchParam";
import { AuthPage } from "../../../components/AuthPage/AuthPage";
import { ButtonLink } from "../../../components/Button/ButtonLink";
import { Spinner } from "../../../components/Spinner/Spinner";
import { useVerifyEmail } from "../queries";

export function VerifyEmailPage() {
  const token = useConsumedSearchParam("token");
  const { mutate, isSuccess, isError, error } = useVerifyEmail();
  const started = useRef(false);

  useEffect(() => {
    // Токен одноразовый: StrictMode в dev не должен отправить его дважды
    if (!token || started.current) return;
    started.current = true;
    mutate({ token });
  }, [token, mutate]);

  if (isSuccess) {
    return (
      <AuthPage title="Почта подтверждена" lead="Владение адресом подтверждено.">
        <ButtonLink to="/account/security">Продолжить</ButtonLink>
      </AuthPage>
    );
  }

  if (isError || !token) {
    return (
      <AuthPage
        title="Ссылка не работает"
        lead={error instanceof ApiError && ["UNAUTHENTICATED", "VERIFICATION_SESSION_REQUIRED"].includes(error.code)
          ? "Для добавления адреса откройте ссылку в браузере, где запросили подтверждение. При необходимости запросите новую ссылку в кабинете."
          : "Ссылка недействительна или устарела. Повторите запрос подтверждения."}
      >
        <ButtonLink to="/activation">Запросить подтверждение</ButtonLink>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Подтверждаем почту">
      <Spinner />
    </AuthPage>
  );
}
