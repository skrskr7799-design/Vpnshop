import { readSecret } from "./secrets";
import { z } from "zod";
import { RemnawaveClient } from "../modules/remnawave/remnawave.client";
import { assignmentPanel } from "../modules/remnawave/remnawave.assignment";

const httpsOrigin = z.url().transform(value => new URL(value)).refine(url =>
  url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
).transform(url => url.origin);

export function stagingPanelSettings() {
  if (process.env.REMNAWAVE_ENABLED === "false") return undefined;
  if (process.env.REMNAWAVE_REVISION_MODE !== "staging") {
    if (process.env.REMNAWAVE_ENABLED === "true") throw new Error("Remnawave requires the isolated staging profile");
    return undefined;
  }
  const result = z.object({
    REMNAWAVE_STAGING_ORIGIN: httpsOrigin,
    REMNAWAVE_STAGING_LINK_ORIGIN: httpsOrigin,
    REMNAWAVE_STAGING_TOKEN: z.string().min(1),
    REMNAWAVE_STAGING_API_KEY: z.string().min(1).optional(),
    REMNAWAVE_STAGING_INSTANCE: z.string().regex(/^staging-[a-z0-9-]{1,50}$/),
    REMNAWAVE_STAGING_SQUADS: z.string().transform(value =>
      Array.from(new Set(value.split(",").map(id => id.trim().toLowerCase()))).sort(),
    ).pipe(z.array(z.uuid()).min(1)),
  }).safeParse({ ...process.env, REMNAWAVE_STAGING_TOKEN: readSecret("REMNAWAVE_STAGING_TOKEN"),
    REMNAWAVE_STAGING_API_KEY: readSecret("REMNAWAVE_STAGING_API_KEY") });
  if (!result.success) throw new Error("Invalid isolated Remnawave staging configuration");
  return result.data;
}

export function stagingPanel(timeoutMs: number) {
  const config = stagingPanelSettings();
  if (!config) return undefined;
  const client = new RemnawaveClient({
    baseUrl: config.REMNAWAVE_STAGING_ORIGIN, token: config.REMNAWAVE_STAGING_TOKEN,
    apiKey: config.REMNAWAVE_STAGING_API_KEY, strictErrors: true, readRetries: 0, timeoutMs,
  });
  return {
    client, squads: config.REMNAWAVE_STAGING_SQUADS,
    panel: assignmentPanel(client, {
      instance: config.REMNAWAVE_STAGING_INSTANCE, origin: config.REMNAWAVE_STAGING_ORIGIN,
      linkOrigin: config.REMNAWAVE_STAGING_LINK_ORIGIN, timeoutMs, allowedSquads: config.REMNAWAVE_STAGING_SQUADS,
    }),
  };
}
