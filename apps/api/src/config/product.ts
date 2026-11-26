import { brandName, productContactEmail, productLink, type PublicProductConfig } from "@vpn/shared";
import { z } from "zod";
import { AppError } from "../lib/errors";

const flag = z.enum(["true", "false"]).transform(value => value === "true");
const optional = <T extends z.ZodType<string>>(field: T) =>
  z.preprocess(value => value === "" ? undefined : value, field.optional());

export const productSettings = {
  BRAND_NAME: brandName.default("MZT"),
  SUPPORT_EMAIL: optional(productContactEmail),
  SUPPORT_URL: optional(productLink),
  LEGAL_TERMS_URL: optional(productLink),
  LEGAL_PRIVACY_URL: optional(productLink),
  LEGAL_REFUND_URL: optional(productLink),
  REGISTRATION_ENABLED: flag.default(true),
  SUPPORT_ENABLED: flag.default(true),
  MAINTENANCE_MODE: flag.default(false),
  PAYMENTS_ENABLED: flag.optional(),
  REMNAWAVE_ENABLED: flag.optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
};

type ProductSettings = z.output<z.ZodObject<typeof productSettings>> & { NODE_ENV: string };
type CommerceDependencies = { provider: boolean; panel: boolean };

export function paymentRestriction(settings: ProductSettings, { provider, panel }: CommerceDependencies) {
  if (settings.MAINTENANCE_MODE) return "MAINTENANCE_MODE";
  if (settings.NODE_ENV === "test" && settings.PAYMENTS_ENABLED === undefined && settings.REMNAWAVE_ENABLED !== false) return undefined;
  if (!settings.PAYMENTS_ENABLED || !provider) return "PAYMENTS_DISABLED";
  if (settings.REMNAWAVE_ENABLED === false || !panel) return "PROVISIONING_UNAVAILABLE";
  return undefined;
}

export function requireAdmission(settings: ProductSettings, feature: "registration" | "support") {
  if (settings.MAINTENANCE_MODE) throw new AppError(503, "MAINTENANCE_MODE");
  if (feature === "registration" && !settings.REGISTRATION_ENABLED) throw new AppError(403, "REGISTRATION_CLOSED");
  if (feature === "support" && !settings.SUPPORT_ENABLED) throw new AppError(503, "SUPPORT_DISABLED");
}

export function runtimeMetadata(settings: ProductSettings): Pick<PublicProductConfig, "version" | "product"> {
  return {
    version: 1,
    product: {
      brandName: settings.BRAND_NAME, supportEmail: settings.SUPPORT_EMAIL, supportUrl: settings.SUPPORT_URL,
      legalTermsUrl: settings.LEGAL_TERMS_URL, legalPrivacyUrl: settings.LEGAL_PRIVACY_URL,
      legalRefundUrl: settings.LEGAL_REFUND_URL,
    },
  };
}

export function publicConfig(settings: ProductSettings, availability: PublicProductConfig["availability"]): PublicProductConfig {
  return { ...runtimeMetadata(settings), availability };
}
