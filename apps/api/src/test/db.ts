import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export async function checkTestDatabase(db: Prisma.TransactionClient = prisma): Promise<void> {
  const token = process.env.VPNSHOP_TEST_MARKER;
  if (process.env.NODE_ENV !== "test" || !token || !/^[a-f0-9]{32}$/.test(token)) {
    throw new Error("Missing disposable database marker");
  }
  const [row] = await db.$queryRaw<{ safe: boolean }[]>`
    SELECT current_database() = 'vpnshop_suite' AND current_user = 'vpnshop_suite'
      AND EXISTS (SELECT 1 FROM test_guard.instance WHERE marker = ${token}) AS safe`;
  if (!row?.safe) throw new Error("Wrong database, role or disposable instance");
}

export async function resetDatabase(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await checkTestDatabase(tx);
    // Explicit application tables, in foreign-key order. The role has DML grants only.
    await tx.refundIntent.deleteMany();
    await tx.adminOperationalSettings.deleteMany();
    await tx.$executeRaw`TRUNCATE "FulfillmentLease", "FulfillmentJob", "DesiredAssignment", "ServiceHold",
      "Adjustment", "PeriodGrant", "OrderAllocation", "Subscription", "RefundIntent", "PaymentTransaction", "PanelObservation", "PanelBinding"`;
    await tx.supportEvent.deleteMany();
    await tx.supportMessage.deleteMany();
    await tx.supportCase.deleteMany();
    await tx.paymentCase.deleteMany();
    await tx.payment.deleteMany();
    await tx.order.deleteMany();
    await tx.offerVersion.deleteMany();
    await tx.planPrice.deleteMany();
    await tx.plan.deleteMany();
    await tx.webhookEvent.deleteMany();
    await tx.merchantAccount.deleteMany();
    await tx.$executeRaw`TRUNCATE "AuditLog"`;
    await tx.adminConfirmation.deleteMany();
    await tx.adminCommand.deleteMany();
    await tx.staffChallenge.deleteMany();
    await tx.staffCredential.deleteMany();
    await tx.staffReset.deleteMany();
    await tx.workerHeartbeat.deleteMany();
    await tx.staffInvite.deleteMany();
    await tx.pendingRegistration.deleteMany();
    await tx.oAuthFlow.deleteMany();
    await tx.authMailWindow.deleteMany();
    // AuthIdentity, Session, VerificationToken and staff credentials cascade from User.
    await tx.user.deleteMany();
  });
}
