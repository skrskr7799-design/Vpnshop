import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { AuthPage } from "../../../components/AuthPage/AuthPage";
import { ButtonLink } from "../../../components/Button/ButtonLink";
import { Spinner } from "../../../components/Spinner/Spinner";
import { useVerifyEmail } from "../queries";

export function VerifyEmailPage() {
  const location = useLocation();
  // Токен читаем один раз и сразу убираем из адресной строки (история, скриншоты, Referer)
  const [token] = useState(() => new URLSearchParams(location.search).get("token"));
  const { mutate, isSuccess, isError } = useVerifyEmail();
  const started = useRef(false);

  useEffect(() => {
    window.history.replaceState(window.history.state, "", location.pathname);
    // Токен одноразовый: StrictMode в dev не должен отправить его дважды
    if (!token || started.current) return;
    started.current = true;
    mutate({ token });
  }, [token, mutate, location.pathname]);

  if (isSuccess) {
    return (
      <AuthPage title="Почта подтверждена" lead="Аккаунт создан. Теперь можно войти.">
        <ButtonLink to="/login">Войти</ButtonLink>
      </AuthPage>
    );
  }

  if (isError || !token) {
    return (
      <AuthPage
        title="Ссылка не работает"
        lead="Она недействительна или устарела. Зарегистрируйтесь ещё раз, и мы отправим новую."
      >
        <ButtonLink to="/register">Зарегистрироваться</ButtonLink>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Подтверждаем почту">
      <Spinner />
    </AuthPage>
  );
}
