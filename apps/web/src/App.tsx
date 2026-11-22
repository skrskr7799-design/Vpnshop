import { SecurityPage } from "./features/auth/pages/SecurityPage";
import { Navigate, Route, Routes } from "react-router";
import { AuthShell } from "./components/AuthShell/AuthShell";
import { GuestOnly, RequireAuth } from "./features/auth/guards";
import { ForgotPasswordPage } from "./features/auth/pages/ForgotPasswordPage";
import { LoginPage } from "./features/auth/pages/LoginPage";
import { RegisterPage } from "./features/auth/pages/RegisterPage";
import { ResetPasswordPage } from "./features/auth/pages/ResetPasswordPage";
import { VerifyEmailPage } from "./features/auth/pages/VerifyEmailPage";
import { AccountShell } from "./features/account/account";
import { DashboardPage, PlansPage, OrdersPage, OrderPage, SubscriptionPage } from "./features/account/CommercePages";
import { ConnectionPage } from "./features/account/ConnectionPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/account" replace />} />

      <Route element={<AuthShell />}>
        {/* только для гостей: вошедшего перекинет дальше */}
        <Route element={<GuestOnly />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        </Route>
        {/* ссылки из писем открываются независимо от того, вошёл ли пользователь */}
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route path="/account" element={<AccountShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="plans" element={<PlansPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="orders/:id" element={<OrderPage />} />
          <Route path="subscription" element={<SubscriptionPage />} />
          <Route path="connect" element={<ConnectionPage />} />
          <Route path="security" element={<SecurityPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
