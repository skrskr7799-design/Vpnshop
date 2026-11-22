import type { MerchantAccount } from "@prisma/client";
import type { PaymentChannel } from "@vpn/shared";
import { z } from "zod";
import { AppError } from "../../lib/errors";

const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const movementSchema = z.object({
  key: identifier,
  kind: z.enum(["CAPTURE", "REFUND", "CHARGEBACK_DEBIT", "CHARGEBACK_REVERSAL", "FEE", "ADJUSTMENT"]),
  amountMinor: z.string().regex(/^[1-9][0-9]{0,17}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  providerTime: z.iso.datetime().nullable(),
  originalMovementKey: identifier.nullable(),
}).refine(movement => {
  if (movement.kind === "CAPTURE") return movement.originalMovementKey === null;
  if (["REFUND", "CHARGEBACK_DEBIT", "CHARGEBACK_REVERSAL"].includes(movement.kind)) {
    return movement.originalMovementKey !== null && movement.originalMovementKey !== movement.key;
  }
  return true;
});
export const observationSchema = z.object({
  externalPaymentId: identifier,
  merchantReference: identifier.nullable(),
  status: z.enum(["AWAITING_CUSTOMER", "PROCESSING", "FAILED", "UNKNOWN", "CONFIRMED"]),
  movement: movementSchema.nullable(),
}).refine(observation => (observation.status === "CONFIRMED") === (observation.movement !== null));

export type Observation = z.infer<typeof observationSchema>;
export type PaymentMovement = NonNullable<Observation["movement"]>;
export type CreatePayment = {
  merchantReference: string;
  amountMinor: number;
  currency: "RUB";
  channel: PaymentChannel;
  expiresAt: Date;
};

// Only throw this when the adapter can prove that creation was rejected before an invoice existed.
export class DefinitiveCreateRejection extends Error {}

export interface PaymentProviderAdapter {
  readonly account: Pick<MerchantAccount, "provider" | "environment" | "merchant">;
  readonly channels: readonly PaymentChannel[];
  readonly redirectOrigin: string;
  createPayment(input: CreatePayment): Promise<{ externalPaymentId: string; url: string }>;
  getPaymentStatus(externalPaymentId: string): Promise<Observation | null>;
  findByMerchantReference?(reference: string): Promise<Observation | null>;
  verifyWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): {
    eventKey: string; observation: Observation;
  };
}

export function safeInvoice(adapter: PaymentProviderAdapter, invoice: { externalPaymentId: string; url: string }) {
  const id = identifier.parse(invoice.externalPaymentId);
  const url = new URL(invoice.url);
  if (url.protocol !== "https:" || url.origin !== adapter.redirectOrigin || url.username || url.password ||
      invoice.url.length > 2048) throw new AppError(502, "INVALID_PAYMENT_REDIRECT");
  return { externalId: id, redirectUrl: url.href };
}
