import { SignatureScene } from "@vpn/ui";
import { Link, Outlet } from "react-router";
import { APP_NAME } from "../../config";

export function AuthShell() {
  return <SignatureScene mainId="auth-main" brand={<Link to="/" className="mz-wordmark">{APP_NAME}</Link>}>
    <Outlet />
  </SignatureScene>;
}
