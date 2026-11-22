import { z } from "zod";
import { orderSnapshotSchema, paymentAttemptSchema, paymentChannelSchema } from "./commerce";

export type Page<T> = { items: T[]; nextCursor: string | null };

export const ownerOrderSummarySchema = z.object({
  id: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), snapshot: orderSnapshotSchema,
  orderStatus: z.enum(["PENDING", "PAID", "FULFILLED", "EXPIRED", "CANCELED", "REFUNDED"]),
  orderState: z.enum(["OPEN", "ALLOCATED", "EXPIRED", "CANCELED", "LEGACY"]),
  moneyStatus: z.enum(["WAITING", "UNKNOWN", "CAPTURE_RECORDED", "LATE_CAPTURE", "REFUNDED", "PARTIAL_REFUND", "REVIEW", "LEGACY"]),
  deliveryStatus: z.enum(["NOT_REQUESTED", "SCHEDULED", "WAITING", "READY", "HELD", "EXPIRED", "REVIEW"]),
  periodId: z.string().nullable(),
});
export const ownerOrderDetailSchema = ownerOrderSummarySchema.extend({
  allowedChannels: z.array(paymentChannelSchema), canStartPayment: z.boolean(),
  refunds: z.array(z.object({ id: z.string(), amountMinor: z.string(), currency: z.string(), confirmedAt: z.iso.datetime().nullable() })),
});

export const periodSchema = z.object({
  id: z.string(), orderId: z.string().nullable(), kind: z.enum(["PURCHASE", "COMPENSATION"]), deviceLimit: z.number(), serial: z.number(), startAt: z.iso.datetime(), endAt: z.iso.datetime(),
  effectiveEndAt: z.iso.datetime(), snapshot: orderSnapshotSchema.nullable(),
  adjustments: z.array(z.object({ id: z.string(), effectiveAt: z.iso.datetime(), kind: z.string() })),
});

export const subscriptionSummarySchema = z.object({
  serverTime: z.iso.datetime(),
  subscription: z.object({
    id: z.string(), rightStatus: z.enum(["ACTIVE", "HELD", "SCHEDULED", "EXPIRED", "EMPTY", "LEGACY_REVIEW"]),
    currentPeriod: periodSchema.nullable(),
    coverageEndsAt: z.iso.datetime().nullable(), paidThroughAt: z.iso.datetime().nullable(), nextBoundaryAt: z.iso.datetime().nullable(),
    delivery: z.object({ status: ownerOrderSummarySchema.shape.deliveryStatus, observedAt: z.iso.datetime().nullable(),
      observationFresh: z.boolean(), reasonCode: z.string().nullable() }),
  }).nullable(),
});

export type OwnerOrderSummary = z.infer<typeof ownerOrderSummarySchema>;
export type OwnerOrderDetail = z.infer<typeof ownerOrderDetailSchema>;
export type OwnerPeriod = z.infer<typeof periodSchema>;
export type OwnerSubscription = z.infer<typeof subscriptionSummarySchema>;
export type OwnerPayment = Omit<z.infer<typeof paymentAttemptSchema>, "status" | "channel" | "expiresAt"> & {
  status: z.infer<typeof paymentAttemptSchema>["status"] | "LEGACY";
  channel: z.infer<typeof paymentChannelSchema> | null;
  expiresAt: string | null;
  confirmedCaptures: { id: string; amountMinor: string; currency: string; confirmedAt: string | null }[];
};
