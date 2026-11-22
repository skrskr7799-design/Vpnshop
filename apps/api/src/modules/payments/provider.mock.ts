import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { sha256 } from "../../lib/crypto";
import { DefinitiveCreateRejection, observationSchema, type CreatePayment, type Observation, type PaymentProviderAdapter } from "./provider";

// Protocol for isolated tests only. This envelope and headers are local fixtures.
export function mockProvider(secret = "isolated-test-fixture", merchant = "mock-shop") {
  const redirectOrigin = "https://payments.example.invalid";
  const sent: CreatePayment[] = [];
  const statuses = new Map<string, Observation>();
  let createBehavior: "ok" | "timeout" | "reject" | "bad-redirect" = "ok";
  const envelope = z.object({
    merchant: z.literal(merchant),
    environment: z.literal("MOCK"),
    eventId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    observation: observationSchema,
  });
  const adapter = {
    account: { provider: "PLATEGA", environment: "MOCK", merchant },
    channels: ["SBP", "CARD"],
    redirectOrigin,
    async createPayment(input: CreatePayment) {
      sent.push(input);
      if (createBehavior === "reject") throw new DefinitiveCreateRejection();
      const externalPaymentId = `invoice-${input.merchantReference}`;
      statuses.set(externalPaymentId, {
        externalPaymentId, merchantReference: input.merchantReference, status: "AWAITING_CUSTOMER", movement: null,
      });
      if (createBehavior === "timeout") throw new Error("fixture timeout");
      const origin = createBehavior === "bad-redirect" ? "https://untrusted.invalid" : redirectOrigin;
      return { externalPaymentId, url: `${origin}/${externalPaymentId}` };
    },
    async getPaymentStatus(id: string) { return statuses.get(id) ?? null; },
    async findByMerchantReference(ref: string) {
      return Array.from(statuses.values()).find(observation => observation.merchantReference === ref) ?? null;
    },
    verifyWebhook(headers: Record<string, string | string[] | undefined>, body: unknown) {
      const token = headers["x-fixture-secret"];
      if (typeof token !== "string" || !timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(secret)))) {
        throw new AppError(401, "UNVERIFIED_EVENT");
      }
      const event = envelope.parse(body);
      return { eventKey: event.eventId, observation: event.observation };
    },
  } satisfies PaymentProviderAdapter;
  return { adapter, sent, statuses, useCreateBehavior(behavior: typeof createBehavior) { createBehavior = behavior; } };
}
