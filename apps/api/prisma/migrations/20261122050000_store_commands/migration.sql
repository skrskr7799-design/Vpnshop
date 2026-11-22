CREATE TABLE "RefundIntent" (
  id TEXT PRIMARY KEY, "captureId" TEXT NOT NULL REFERENCES "PaymentTransaction"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "commandId" TEXT NOT NULL, "initiatorId" TEXT NOT NULL, "approvedBy" TEXT, "approvedAt" TIMESTAMP(3),
  "amountMinor" BIGINT NOT NULL, currency TEXT NOT NULL, reason TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("amountMinor" > 0),
  CHECK (("approvedBy" IS NULL) = ("approvedAt" IS NULL)),
  CHECK ("approvedBy" IS NULL OR "approvedBy" <> "initiatorId")
);
CREATE UNIQUE INDEX "RefundIntent_commandId_key" ON "RefundIntent"("commandId");
CREATE INDEX "RefundIntent_captureId_expiresAt_idx" ON "RefundIntent"("captureId","expiresAt");
CREATE INDEX "RefundIntent_createdAt_id_idx" ON "RefundIntent"("createdAt",id);

CREATE TABLE "AdminOperationalSettings" (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0,
  "fulfillmentLagWarnSeconds" INTEGER NOT NULL DEFAULT 900,
  "paymentLagWarnSeconds" INTEGER NOT NULL DEFAULT 900,
  CHECK (id = 'default')
);

ALTER TABLE "PeriodGrant" ALTER COLUMN "orderId" DROP NOT NULL, ALTER COLUMN "allocationId" DROP NOT NULL,
  ADD COLUMN "incidentId" TEXT, ADD COLUMN "basisGrantId" TEXT, ADD COLUMN "compensationReason" TEXT,
  ADD CONSTRAINT "PeriodGrant_basisGrantId_fkey" FOREIGN KEY ("basisGrantId") REFERENCES "PeriodGrant"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PeriodGrant_provenance" CHECK (
    ("orderId" IS NOT NULL AND "allocationId" IS NOT NULL AND num_nonnulls("incidentId","basisGrantId","compensationReason") = 0)
    OR ("orderId" IS NULL AND "allocationId" IS NULL AND num_nonnulls("incidentId","basisGrantId","compensationReason") = 3)
  );
CREATE UNIQUE INDEX "PeriodGrant_subscriptionId_incidentId_key" ON "PeriodGrant"("subscriptionId","incidentId");
