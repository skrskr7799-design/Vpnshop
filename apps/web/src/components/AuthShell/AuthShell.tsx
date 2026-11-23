import { BrandMark, SignatureScene } from "@vpn/ui";
import { Link, Outlet } from "react-router";

export function AuthShell() {
  return <SignatureScene mainId="auth-main" brand={<Link to="/" className="mz-brand-home"><BrandMark /></Link>}>
    <Outlet />
  </SignatureScene>;
}
