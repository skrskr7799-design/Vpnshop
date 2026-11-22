import { Suspense, lazy } from "react";
import { Skeleton } from "@vpn/ui";
import { Navigate, Route, Routes } from "react-router";
import { AuthShell } from "./components/AuthShell/AuthShell";
import { GuestOnly, RequireAuth } from "./features/auth/guards";
import { LoginPage } from "./features/auth/pages/LoginPage";
import { AccountShell } from "./features/account/account";
import { NotFoundPage } from "./pages/NotFoundPage";

const ForgotPasswordPage = lazy(() => import("./features/auth/pages/ForgotPasswordPage").then(m => ({ default: m.ForgotPasswordPage })));
const RegisterPage = lazy(() => import("./features/auth/pages/RegisterPage").then(m => ({ default: m.RegisterPage })));
const ResetPasswordPage = lazy(() => import("./features/auth/pages/ResetPasswordPage").then(m => ({ default: m.ResetPasswordPage })));
const VerifyEmailPage = lazy(() => import("./features/auth/pages/VerifyEmailPage").then(m => ({ default: m.VerifyEmailPage })));
const SecurityPage = lazy(() => import("./features/auth/pages/SecurityPage").then(m => ({ default: m.SecurityPage })));
const Commerce = () => import("./features/account/CommercePages");
const DashboardPage = lazy(() => Commerce().then(m => ({ default: m.DashboardPage })));
const PlansPage = lazy(() => Commerce().then(m => ({ default: m.PlansPage })));
const OrdersPage = lazy(() => Commerce().then(m => ({ default: m.OrdersPage })));
const OrderPage = lazy(() => Commerce().then(m => ({ default: m.OrderPage })));
const SubscriptionPage = lazy(() => Commerce().then(m => ({ default: m.SubscriptionPage })));
const ConnectionPage = lazy(() => import("./features/account/ConnectionPage").then(m => ({ default: m.ConnectionPage })));
const Support = () => import("./features/account/SupportPages");
const SupportPage = lazy(() => Support().then(m => ({ default: m.SupportPage })));
const SupportThreadPage = lazy(() => Support().then(m => ({ default: m.SupportThreadPage })));

export function App() {
  return (
    <Suspense fallback={<Skeleton />}><Routes>
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
          <Route path="support" element={<SupportPage />} />
          <Route path="support/:id" element={<SupportThreadPage />} />
          <Route path="security" element={<SecurityPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes></Suspense>
  );
}
