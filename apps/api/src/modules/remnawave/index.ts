import { z } from "zod";
import { panelSettings } from "../../config/panel-env";
const env = z.object(panelSettings).parse(process.env);
import { RemnawaveClient } from "./remnawave.client";

export const remnawave = new RemnawaveClient({
  baseUrl: env.REMNAWAVE_URL,
  token: env.REMNAWAVE_TOKEN,
  apiKey: env.REMNAWAVE_API_KEY,
  trustedProxyHeaders: env.REMNAWAVE_TRUSTED_PROXY_HEADERS,
});

export { checkPanelCompatibility } from "./remnawave.compat";
export { computeTargetExpireAt, addMonths } from "./remnawave.dates";
export { RemnawaveError } from "./remnawave.errors";
export { applySubscription, planExpiry } from "./remnawave.provisioning";
export { remnawaveUsernameFor } from "./remnawave.username";
