import { z } from "zod";

export const brandName = z.string().trim().min(1).refine(value => [...value].length <= 80 && !/[\p{Cc}\p{Cf}]/u.test(value));
export const productLink = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return value.startsWith("https://") && url.protocol === "https:" && !url.username && !url.password && !!url.hostname &&
    !/[\p{Cc}\p{Cf}\\]/u.test(value);
});
export const productContactEmail = z.email().max(254);
export const productMetadata = z.strictObject({
  brandName, supportEmail: productContactEmail.optional(), supportUrl: productLink.optional(),
  legalTermsUrl: productLink.optional(), legalPrivacyUrl: productLink.optional(), legalRefundUrl: productLink.optional(),
});
export const publicProductMetadata = z.strictObject({ version: z.literal(1), product: productMetadata });
export const publicProductConfig = publicProductMetadata.extend({
  availability: z.strictObject({
    registration: z.boolean(), payments: z.boolean(), support: z.boolean(),
    maintenance: z.boolean(), google: z.boolean(), telegram: z.boolean(),
  }),
});
export type PublicProductConfig = z.infer<typeof publicProductConfig>;
