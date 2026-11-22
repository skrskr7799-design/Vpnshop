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
  ADD CONSTRAINT "PeriodGrant_provenance" CHECK (
    ("orderId" IS NOT NULL AND "allocationId" IS NOT NULL AND num_nonnulls("incidentId","basisGrantId","compensationReason") = 0)
    OR ("orderId" IS NULL AND "allocationId" IS NULL AND num_nonnulls("incidentId","basisGrantId","compensationReason") = 3)
  );
CREATE UNIQUE INDEX "PeriodGrant_subscriptionId_incidentId_key" ON "PeriodGrant"("subscriptionId","incidentId");
CREATE UNIQUE INDEX "PeriodGrant_id_subscriptionId_key" ON "PeriodGrant"(id,"subscriptionId");
ALTER TABLE "PeriodGrant" ADD CONSTRAINT "PeriodGrant_basisGrantId_subscriptionId_fkey"
  FOREIGN KEY ("basisGrantId","subscriptionId") REFERENCES "PeriodGrant"(id,"subscriptionId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION vpnshop_refund_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'RefundIntent history is immutable'; END IF;
  IF (NEW.id, NEW."captureId", NEW."commandId", NEW."initiatorId", NEW."amountMinor", NEW.currency, NEW.reason, NEW."createdAt", NEW."expiresAt")
    IS DISTINCT FROM
    (OLD.id, OLD."captureId", OLD."commandId", OLD."initiatorId", OLD."amountMinor", OLD.currency, OLD.reason, OLD."createdAt", OLD."expiresAt")
    OR OLD."approvedAt" IS NOT NULL
    OR NEW."approvedAt" IS NULL THEN
    RAISE EXCEPTION 'RefundIntent history is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vpnshop_refund_intent_immutable BEFORE UPDATE OR DELETE ON "RefundIntent"
FOR EACH ROW EXECUTE FUNCTION vpnshop_refund_intent_immutable();
