import { Outlet } from "react-router";
import { APP_NAME } from "../../config";
import { RouteMap } from "../RouteMap/RouteMap";
import "./AuthShell.css";

// Общий каркас страниц входа. Это layout-роут: при переходах между входом и регистрацией
// панель не перерисовывается, поэтому рисунок анимируется один раз.
export function AuthShell() {
  return (
    <div className="auth-shell">
      <aside className="auth-shell__panel">
        <p className="auth-shell__brand">{APP_NAME}</p>
        <div className="auth-shell__map">
          <RouteMap />
        </div>
        <p className="auth-shell__statement">Одна подписка для всех ваших устройств</p>
      </aside>
      <main className="auth-shell__main">
        <div className="auth-shell__content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
