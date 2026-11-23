import { useEffect } from "react";
import { BrandMark, SignatureScene } from "@vpn/ui";
import { Link } from "react-router";
import { AuthPage } from "../components/AuthPage/AuthPage";
import { ButtonLink } from "../components/Button/ButtonLink";
import { APP_NAME } from "../config";

export function NotFoundPage() {
  useEffect(() => {
    document.title = `Страница не найдена — ${APP_NAME}`;
  }, []);

  return (
    <SignatureScene mainId="auth-main" brand={<Link to="/" className="mz-brand-home"><BrandMark /></Link>}>
      <AuthPage title="Страница не найдена" lead="Проверьте адрес или вернитесь на главную.">
        <ButtonLink to="/">На главную</ButtonLink>
      </AuthPage>
    </SignatureScene>
  );
}
