import { Suspense, lazy } from "react";
import { Skeleton } from "@vpn/ui";
import { Navigate, Route, Routes } from "react-router";
import { AuthShell } from "./components/AuthShell/AuthShell";
import { GuestOnly, RequireAuth } from "./features/auth/guards";
import { loadDashboard as Commerce } from "./features/auth/entry";
import { LoginPage } from "./features/auth/pages/LoginPage";
import { useProductConfig } from "./config";
import { AuthPage } from "./components/AuthPage/AuthPage";
import { ButtonLink } from "./components/Button/ButtonLink";
import { ProductLinks } from "./components/ProductLinks";
import { NotFoundPage } from "./pages/NotFoundPage";

const AccountShell = lazy(() => import("./features/account/account").then(m => ({ default: m.AccountShell })));
const RegisterPage = lazy(() => import("./features/auth/pages/RegisterPage").then(m => ({ default: m.RegisterPage })));
const ActivationPage = lazy(() => import("./features/auth/pages/ActivationPage").then(m => ({ default: m.ActivationPage })));
const ForgotPasswordPage = lazy(() => import("./features/auth/pages/ForgotPasswordPage").then(m => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import("./features/auth/pages/ResetPasswordPage").then(m => ({ default: m.ResetPasswordPage })));
const VerifyEmailPage = lazy(() => import("./features/auth/pages/VerifyEmailPage").then(m => ({ default: m.VerifyEmailPage })));
const SecurityPage = lazy(() => import("./features/auth/pages/SecurityPage").then(m => ({ default: m.SecurityPage })));
const DashboardPage = lazy(() => Commerce().then(m => ({ default: m.DashboardPage })));
const PlansPage = lazy(() => Commerce().then(m => ({ default: m.PlansPage })));
const OrdersPage = lazy(() => Commerce().then(m => ({ default: m.OrdersPage })));
const OrderPage = lazy(() => Commerce().then(m => ({ default: m.OrderPage })));
const SubscriptionPage = lazy(() => Commerce().then(m => ({ default: m.SubscriptionPage })));
const ConnectionPage = lazy(() => import("./features/account/ConnectionPage").then(m => ({ default: m.ConnectionPage })));
const Support = () => import("./features/account/SupportPages");
const SupportPage = lazy(() => Support().then(m => ({ default: m.SupportPage })));
const SupportThreadPage = lazy(() => Support().then(m => ({ default: m.SupportThreadPage })));

function Home() {
  const { data, isPending } = useProductConfig();
  if (isPending) return <Skeleton />;
  return <Navigate to={data?.availability.maintenance ? "/maintenance" : "/account"} replace />;
}

function Maintenance() {
  const { data, isPending } = useProductConfig();
  if (isPending) return <Skeleton />;
  if (data && !data.availability.maintenance) return <Navigate to="/account" replace />;
  return <AuthPage title="Техническое обслуживание"
    lead="Новые регистрации, покупки и обращения временно приостановлены. Действующие заказы и обращения доступны в кабинете.">
    <ButtonLink to="/account">Открыть кабинет</ButtonLink><ProductLinks kind="support" />
  </AuthPage>;
}

export function App() {
  return (
    <Suspense fallback={<Skeleton />}><Routes>
      <Route path="/" element={<Home />} />

      <Route element={<AuthShell />}>
        <Route path="/maintenance" element={<Maintenance />} />
        {/* только для гостей: вошедшего перекинет дальше */}
        <Route element={<GuestOnly />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        </Route>
        {/* ссылки из писем открываются независимо от того, вошёл ли пользователь */}
        <Route path="/activation" element={<ActivationPage />} />
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
