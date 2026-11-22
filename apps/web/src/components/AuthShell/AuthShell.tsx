import { Labyrinth } from "@vpn/ui";
import { Link, Outlet } from "react-router";
import { APP_NAME } from "../../config";
import "./AuthShell.css";

export function AuthShell() {
  return <div className="auth-shell">
    <a className="mz-skip" href="#auth-main">Перейти к форме</a>
    <aside className="auth-shell__panel" aria-label={APP_NAME}>
      <header><Link to="/" className="mz-wordmark">{APP_NAME}</Link></header>
      <div className="auth-shell__map"><Labyrinth /></div>
      <div className="auth-shell__brand-copy">
        <p className="auth-shell__statement">Приватное<br />подключение.</p>
        <p className="auth-shell__caption">Одна подписка для всех ваших устройств.</p>
      </div>
    </aside>
    <main id="auth-main" className="auth-shell__main" tabIndex={-1}>
      <div className="auth-shell__content"><Outlet /></div>
    </main>
  </div>;
}
