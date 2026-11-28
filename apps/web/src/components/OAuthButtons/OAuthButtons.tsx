import { OAUTH_PROVIDERS } from "@vpn/shared";
import { OAUTH_LABELS, oauthStartUrl, useOAuthProviders } from "../../features/auth/oauth";
import { buttonClass } from "../Button/Button";
import { readEntryMethod } from "../../features/auth/entry";
import { ProviderIcon } from "./ProviderIcon";
import "./OAuthButtons.css";

// Кнопки входа через внешние сервисы. Показываются только для включённых на сервере.
export function OAuthButtons({ returnTo, placement = "below" }: { returnTo?: string; placement?: "above" | "below" }) {
  const { data } = useOAuthProviders();
  const enabled = OAUTH_PROVIDERS.filter((provider) => data?.[provider]);
  const lastMethod = readEntryMethod();
  if (lastMethod && lastMethod !== "email" && enabled.includes(lastMethod)) {
    enabled.splice(enabled.indexOf(lastMethod), 1);
    enabled.unshift(lastMethod);
  }
  if (enabled.length === 0) return null;

  return (
    <div className="oauth">
      {placement === "below" && <p className="oauth__divider">или</p>}
      <div className="oauth__buttons">
        {enabled.map((provider) => (
          <a key={provider} className={buttonClass("secondary", true)} data-last-method={provider === lastMethod || undefined} href={oauthStartUrl(provider, returnTo)}>
            <ProviderIcon provider={provider} />
            {OAUTH_LABELS[provider]}
            {provider === lastMethod && <span className="oauth__recent">Последний вход</span>}
          </a>
        ))}
      </div>
      {placement === "above" && <p className="oauth__divider">или по почте</p>}
    </div>
  );
}
