import type { MerchantAccount, WebhookEvent } from "@prisma/client";
import { sha256 } from "../../lib/crypto";
import { prisma } from "../../lib/prisma";
import { dbNow } from "../commerce/offers";
import { recordObservation } from "./ledger";
import { observationSchema, type Observation } from "./provider";
import { lockPaymentKey, nextCheck, noteCase } from "./store";

// Commit the full normalized observation before the handler sends ACK.
export async function acceptWebhook(account: MerchantAccount, eventKey: string, input: Observation) {
  const observation = observationSchema.parse(input);
  const fingerprint = sha256(JSON.stringify(observation));
  return prisma.$transaction(async db => {
    await lockPaymentKey(db, "event", account.id, eventKey);
    const now = await dbNow(db);
    const identity = { accountId: account.id, eventKey };
    const existing = await db.webhookEvent.findUnique({ where: { accountId_eventKey: identity } });
    if (!existing) {
      await db.webhookEvent.create({ data: {
        ...identity, provider: account.provider, signatureValid: true,
        payload: observation, fingerprint, evidence: "WEBHOOK", receivedAt: now, nextCheckAt: now,
      } });
    } else if (existing.fingerprint !== fingerprint) {
      await noteCase(db, account, "EVENT_CONFLICT", `event:${eventKey}:${fingerprint}`,
        "EVENT_CONFLICT", { originalEventId: existing.id, observation }, now);
    }
  }, { isolationLevel: "ReadCommitted" });
}

export async function processInbox(account: MerchantAccount, limit = 20) {
  let processed = 0;
  for (; processed < limit; processed++) {
    let eventId: string | undefined;
    try {
      const found = await prisma.$transaction(async db => {
        const [event] = await db.$queryRaw<WebhookEvent[]>`
          SELECT * FROM "WebhookEvent" WHERE "accountId" = ${account.id} AND "processedAt" IS NULL
            AND attempts < 8 AND "nextCheckAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
          ORDER BY "nextCheckAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
        `;
        if (!event) return false;
        eventId = event.id;
        // All state changes are local SQL. A crash rolls back both movement and processedAt.
        await recordObservation(db, account, observationSchema.parse(event.payload), "WEBHOOK", event.receivedAt);
        await db.webhookEvent.update({ where: { id: event.id }, data: {
          processedAt: await dbNow(db), nextCheckAt: null, attempts: { increment: 1 }, error: null,
        } });
        return true;
      }, { isolationLevel: "ReadCommitted" });
      if (!found) break;
    } catch (error) {
      if (!eventId) throw error;
      const id = eventId;
      await prisma.$transaction(async db => {
        const now = await dbNow(db);
        const changed = await db.webhookEvent.updateMany({
          where: { id, processedAt: null },
          data: { attempts: { increment: 1 }, error: "INBOX_PROCESSING_FAILED", nextCheckAt: nextCheck(now) },
        });
        if (changed.count) await noteCase(db, account, "INBOX_PROCESSING_FAILED", `inbox:${id}`,
          "INBOX_PROCESSING_FAILED", {}, now);
      });
    }
  }
  return processed;
}
