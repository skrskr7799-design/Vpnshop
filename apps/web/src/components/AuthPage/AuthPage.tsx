import { useEffect, useRef, type ReactNode } from "react";
import { useProductConfig } from "../../config";
import "./AuthPage.css";

type AuthPageProps = { title: string; lead?: ReactNode; children: ReactNode };

// Заголовок + содержимое страницы. При смене экрана переносит фокус на заголовок
// и обновляет title вкладки: так переход слышат пользователи скринридеров.
export function AuthPage({ title, lead, children }: AuthPageProps) {
  const brand = useProductConfig().data?.product.brandName ?? "MZT";
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = `${title} — ${brand}`;
    headingRef.current?.focus({ preventScroll: true });
  }, [title, brand]);

  return (
    <section className="auth-page">
      <h1 ref={headingRef} tabIndex={-1} className="auth-page__title">
        {title}
      </h1>
      {lead && <p className="auth-page__lead">{lead}</p>}
      <div className="auth-page__body">{children}</div>
    </section>
  );
}
