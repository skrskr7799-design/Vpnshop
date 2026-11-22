import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { decrypt, deriveKey, encrypt } from "../../lib/secret-box";
import type { Mail } from "./mail.service";

const mailKey = () => deriveKey(env.MAIL_QUEUE_KEY!, "notification-outbox-v1");

export async function enqueueMail(db: Prisma.TransactionClient, mail: Mail, expiresAt: Date) {
  if (!env.MAIL_QUEUE_KEY) return;
  await db.notificationOutbox.create({ data: { payload: encrypt(JSON.stringify(mail), mailKey()), expiresAt }, select: { id: true } });
}

export async function deliverNext(send: (mail: Mail, id: string) => Promise<void>) {
  const leaseId = randomUUID();
  await prisma.notificationOutbox.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  const [entry] = await prisma.$queryRaw<{ id: string; payload: string }[]>`
    WITH candidate AS (
      SELECT id FROM "NotificationOutbox"
      WHERE "expiresAt" > timezone('utc', clock_timestamp()) AND "dueAt" <= timezone('utc', clock_timestamp())
        AND ("leaseUntil" IS NULL OR "leaseUntil" < timezone('utc', clock_timestamp())) AND attempts < 6
      ORDER BY "dueAt",id LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE "NotificationOutbox" n SET "leaseId" = ${leaseId},
      "leaseUntil" = timezone('utc', clock_timestamp()) + interval '2 minutes', attempts = n.attempts + 1
    FROM candidate WHERE n.id = candidate.id RETURNING n.id, n.payload`;
  if (!entry) return false;
  try {
    await send(JSON.parse(decrypt(entry.payload, mailKey())) as Mail, entry.id);
  } catch {
    await prisma.notificationOutbox.updateMany({ where: { id: entry.id, leaseId }, data: {
      dueAt: new Date(Date.now() + 60_000), leaseId: null, leaseUntil: null,
    } });
    throw new Error("NOTIFICATION_DELIVERY_FAILED");
  }
  await prisma.notificationOutbox.deleteMany({ where: { id: entry.id, leaseId } });
  return true;
}
