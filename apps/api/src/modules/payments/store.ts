import type { MerchantAccount, Order, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import type { PaymentProviderAdapter } from "./provider";

export type Db = Prisma.TransactionClient;

export async function merchantAccount(adapter: PaymentProviderAdapter) {
  await prisma.merchantAccount.createMany({ data: [adapter.account], skipDuplicates: true });
  return prisma.merchantAccount.findUniqueOrThrow({ where: { provider_environment_merchant: adapter.account } });
}

export async function lockOrder(db: Db, id: string) {
  const [order] = await db.$queryRaw<Order[]>`SELECT * FROM mzt_lock_order(${id})`;
  return order;
}

// Scope collision only introduces waiting. Database unique constraints enforce identity.
export async function lockPaymentKey(db: Db, scope: string, accountId: string, key: string) {
  const lockKey = JSON.stringify([scope, accountId, key]);
  await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
}

// Short DB-only finance gate shared by inbox acceptance, ledger ingestion and allocation.
export function lockEntitlementAccount(db: Db, accountId: string) {
  return lockPaymentKey(db, "entitlement", accountId, accountId);
}

export async function noteCase(
  db: Db, account: Pick<MerchantAccount, "id">, kind: string, objectKey: string,
  reason: string, details: Prisma.InputJsonObject, now: Date,
) {
  const key = { accountId: account.id, objectKey, kind };
  // Repeats retain the original evidence and resolution history.
  await db.paymentCase.createMany({
    data: [{ ...key, reason, details, nextCheckAt: now, history: [{ status: "OPEN", reason, at: now.toISOString() }] }],
    skipDuplicates: true,
  });
}

export const nextCheck = (now: Date) => new Date(now.getTime() + 60_000);
