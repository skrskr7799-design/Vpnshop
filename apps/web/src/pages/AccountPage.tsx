import { useEffect } from "react";
import { Button } from "../components/Button/Button";
import { APP_NAME } from "../config";
import { Link } from "react-router";
import { useLogout, useMe } from "../features/auth/queries";
import "./AccountPage.css";

export function AccountPage() {
  const { data: user } = useMe();
  const logout = useLogout();

  useEffect(() => {
    document.title = `Аккаунт — ${APP_NAME}`;
  }, []);

  // RequireAuth гарантирует пользователя; проверка нужна для типов
  if (!user) return null;

  return (
    <div className="account">
      <header className="account__header">
        <p className="account__brand">{APP_NAME}</p>
        <Button variant="secondary" block={false} loading={logout.isPending} onClick={() => logout.mutate()}>
          Выйти
        </Button>
      </header>
      <main className="account__main">
        <h1 className="account__title">Аккаунт</h1>
        {user.email && (
          <dl className="account__details">
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </dl>
        )}
        <Link to="/account/security">Устройства и способы входа</Link>
      </main>
    </div>
  );
}
