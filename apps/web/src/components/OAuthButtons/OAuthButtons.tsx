import { OAUTH_PROVIDERS } from "@vpn/shared";
import { OAUTH_LABELS, oauthStartUrl, useOAuthProviders } from "../../features/auth/oauth";
import { buttonClass } from "../Button/Button";
import { ProviderIcon } from "./ProviderIcon";
import "./OAuthButtons.css";

// Кнопки входа через внешние сервисы. Показываются только для включённых на сервере.
export function OAuthButtons({ returnTo }: { returnTo?: string }) {
  const { data } = useOAuthProviders();
  const enabled = OAUTH_PROVIDERS.filter((provider) => data?.[provider]);
  if (enabled.length === 0) return null;

  return (
    <div className="oauth">
      <p className="oauth__divider">или</p>
      <div className="oauth__buttons">
        {enabled.map((provider) => (
          <a key={provider} className={buttonClass("secondary", true)} href={oauthStartUrl(provider, returnTo)}>
            <ProviderIcon provider={provider} />
            Продолжить через {OAUTH_LABELS[provider]}
          </a>
        ))}
      </div>
    </div>
  );
}
