import { z } from "zod";
import { CURRENCIES } from "../constants";

const uuid = z.uuid().transform(id => id.toLowerCase());
const timestamp = z.iso.datetime();
export const catalogQuerySchema = z.strictObject({ currency: z.enum(CURRENCIES).optional() });
export const checkoutBodySchema = z.strictObject({ offerVersionId: uuid });
export const orderParamsSchema = z.strictObject({ id: uuid });
export const checkoutKeySchema = z.string().min(16).max(128).regex(/^[!-~]+$/).refine(key => !key.includes(","));

const offerTermsSchema = z.object({
  offerId: uuid,
  planId: uuid,
  name: z.string(),
  version: z.number().int().positive(),
  durationMonths: z.number().int().min(1).max(36),
  price: z.strictObject({ amountMinor: z.number().int().positive(), currency: z.enum(CURRENCIES) }),
  deviceLimit: z.number().int().positive(),
  trafficLimitBytes: z.null(),
  trafficStrategy: z.null(),
});

export const offerSchema = offerTermsSchema.strict().extend({ id: uuid, availableUntil: z.null() });
export const catalogSchema = z.strictObject({ offers: z.array(offerSchema), asOf: timestamp });
export const orderSnapshotSchema = offerTermsSchema
  .omit({ offerId: true, version: true, name: true }).strict().extend({
    offerId: uuid.nullable(),
    offerVersionId: uuid.nullable(),
    name: z.string().nullable(),
    version: z.number().int().positive().nullable(),
    policyVersion: z.number().int().positive().nullable(),
    snapshottedAt: timestamp,
    expiresAt: timestamp,
  });
export const checkoutResponseSchema = z.strictObject({
  orderId: uuid, snapshot: orderSnapshotSchema, expiresAt: timestamp,
});
export const paymentChannelSchema = z.enum(["CARD", "SBP"]);
export const orderDetailSchema = z.strictObject({
  id: uuid, createdAt: timestamp, expiresAt: timestamp, snapshot: orderSnapshotSchema,
  orderStatus: z.enum(["PENDING", "PAID", "FULFILLED", "EXPIRED", "CANCELED", "REFUNDED"]),
  allowedChannels: z.array(paymentChannelSchema),
  canStartPayment: z.boolean(),
});
export type Offer = z.infer<typeof offerSchema>;
export type OrderSnapshot = z.infer<typeof orderSnapshotSchema>;

export type PaymentChannel = z.infer<typeof paymentChannelSchema>;
export const createPaymentSchema = z.strictObject({ channel: paymentChannelSchema });
export const paymentParamsSchema = z.strictObject({ id: uuid, paymentId: uuid });
export const paymentAttemptSchema = z.strictObject({
  id: uuid, channel: paymentChannelSchema, status: z.enum([
    "CREATED", "SUBMITTING", "AWAITING_CUSTOMER", "PROCESSING", "UNKNOWN", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELED",
  ]),
  createdAt: timestamp, updatedAt: timestamp, expiresAt: timestamp, reasonCode: z.string().nullable(),
});
export const paymentResponseSchema = z.strictObject({
  attempt: paymentAttemptSchema,
  nextAction: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("WAIT") }),
    z.strictObject({ type: z.literal("REDIRECT"), url: z.url(), expiresAt: timestamp }),
  ]),
});
