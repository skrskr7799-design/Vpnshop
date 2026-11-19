import { useEffect } from "react";
import { ButtonLink } from "../components/Button/ButtonLink";
import { APP_NAME } from "../config";
import "./NotFoundPage.css";

export function NotFoundPage() {
  useEffect(() => {
    document.title = `Страница не найдена — ${APP_NAME}`;
  }, []);

  return (
    <main className="not-found">
      <h1 className="not-found__title">Страница не найдена</h1>
      <p>Проверьте адрес или вернитесь на главную.</p>
      <ButtonLink to="/" block={false}>
        На главную
      </ButtonLink>
    </main>
  );
}
