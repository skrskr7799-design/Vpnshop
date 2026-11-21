BEGIN;

ALTER TYPE "PaymentStatus" ADD VALUE 'CREATED';
ALTER TYPE "PaymentStatus" ADD VALUE 'SUBMITTING';
ALTER TYPE "PaymentStatus" ADD VALUE 'AWAITING_CUSTOMER';
ALTER TYPE "PaymentStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "PaymentStatus" ADD VALUE 'UNKNOWN';
ALTER TYPE "PaymentStatus" ADD VALUE 'SUCCEEDED';
ALTER TYPE "PaymentStatus" ADD VALUE 'CANCELED';
CREATE TYPE "MerchantEnvironment" AS ENUM ('MOCK', 'SANDBOX', 'PRODUCTION');
CREATE TYPE "MovementKind" AS ENUM ('CAPTURE', 'REFUND', 'CHARGEBACK_DEBIT', 'CHARGEBACK_REVERSAL', 'FEE', 'ADJUSTMENT');
CREATE TYPE "PaymentEvidence" AS ENUM ('WEBHOOK', 'LOOKUP');
CREATE TYPE "PaymentCaseStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED');

CREATE TABLE "MerchantAccount" (
  id TEXT PRIMARY KEY,
  provider "PaymentProvider" NOT NULL,
  environment "MerchantEnvironment" NOT NULL,
  merchant TEXT NOT NULL
);
CREATE UNIQUE INDEX "MerchantAccount_provider_environment_merchant_key"
  ON "MerchantAccount" (provider, environment, merchant);

ALTER TABLE "Payment"
  ADD COLUMN "accountId" TEXT REFERENCES "MerchantAccount"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "merchantReference" TEXT,
  ADD COLUMN "requestKeyHash" TEXT,
  ADD COLUMN channel TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "nextCheckAt" TIMESTAMP(3),
  ADD COLUMN "reasonCode" TEXT,
  ADD COLUMN "redirectUrl" TEXT,
  ADD CONSTRAINT "Payment_managed_intent" CHECK ("accountId" IS NULL OR
    num_nonnulls("merchantReference", "requestKeyHash", channel, "expiresAt") = 4);
DROP INDEX "Payment_provider_externalId_key";
CREATE UNIQUE INDEX "Payment_legacy_provider_externalId_key" ON "Payment"(provider, "externalId") WHERE "accountId" IS NULL;
CREATE UNIQUE INDEX "Payment_accountId_externalId_key" ON "Payment"("accountId", "externalId");
CREATE UNIQUE INDEX "Payment_accountId_merchantReference_key" ON "Payment"("accountId", "merchantReference");
CREATE UNIQUE INDEX "Payment_orderId_requestKeyHash_key" ON "Payment"("orderId", "requestKeyHash");
CREATE INDEX "Payment_accountId_nextCheckAt_idx" ON "Payment"("accountId", "nextCheckAt");

ALTER TABLE "WebhookEvent"
  ADD COLUMN "accountId" TEXT REFERENCES "MerchantAccount"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN fingerprint TEXT,
  ADD COLUMN evidence "PaymentEvidence",
  ADD COLUMN "nextCheckAt" TIMESTAMP(3),
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "WebhookEvent_managed_proof" CHECK ("accountId" IS NULL OR
    ("signatureValid" AND fingerprint IS NOT NULL AND evidence IS NOT NULL));
DROP INDEX "WebhookEvent_provider_eventKey_key";
CREATE UNIQUE INDEX "WebhookEvent_legacy_provider_eventKey_key" ON "WebhookEvent"(provider, "eventKey") WHERE "accountId" IS NULL;
CREATE UNIQUE INDEX "WebhookEvent_accountId_eventKey_key" ON "WebhookEvent"("accountId", "eventKey");
CREATE INDEX "WebhookEvent_accountId_processedAt_nextCheckAt_idx" ON "WebhookEvent"("accountId", "processedAt", "nextCheckAt");

CREATE TABLE "PaymentTransaction" (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "MerchantAccount"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "movementKey" TEXT NOT NULL,
  kind "MovementKind" NOT NULL,
  "amountMinor" BIGINT NOT NULL CHECK ("amountMinor" > 0),
  currency TEXT NOT NULL,
  "providerTime" TIMESTAMP(3),
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evidence "PaymentEvidence" NOT NULL,
  "externalPaymentId" TEXT NOT NULL,
  "merchantReference" TEXT,
  "originalMovementKey" TEXT,
  "paymentId" TEXT REFERENCES "Payment"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentTransaction_accountId_movementKey_key" ON "PaymentTransaction"("accountId", "movementKey");
CREATE INDEX "PaymentTransaction_accountId_originalMovementKey_idx" ON "PaymentTransaction"("accountId", "originalMovementKey");
CREATE INDEX "PaymentTransaction_accountId_externalPaymentId_idx" ON "PaymentTransaction"("accountId", "externalPaymentId");
CREATE INDEX "PaymentTransaction_accountId_merchantReference_idx" ON "PaymentTransaction"("accountId", "merchantReference");
CREATE INDEX "PaymentTransaction_paymentId_idx" ON "PaymentTransaction"("paymentId");

CREATE FUNCTION vpnshop_append_only_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Payment ledger is append-only';
END;
$$;
CREATE TRIGGER append_only_ledger BEFORE UPDATE OR DELETE ON "PaymentTransaction"
FOR EACH ROW EXECUTE FUNCTION vpnshop_append_only_ledger();

CREATE FUNCTION vpnshop_freeze_payment_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."accountId" IS NOT NULL AND (
    ROW(NEW.id, NEW."orderId", NEW.provider, NEW."accountId", NEW."merchantReference",
        NEW."requestKeyHash", NEW.channel, NEW.amount, NEW.currency, NEW."expiresAt")
    IS DISTINCT FROM
    ROW(OLD.id, OLD."orderId", OLD.provider, OLD."accountId", OLD."merchantReference",
        OLD."requestKeyHash", OLD.channel, OLD.amount, OLD.currency, OLD."expiresAt")
    OR (OLD."externalId" IS NOT NULL AND NEW."externalId" IS DISTINCT FROM OLD."externalId")
  ) THEN
    RAISE EXCEPTION 'Payment intent is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER freeze_payment_intent BEFORE UPDATE ON "Payment"
FOR EACH ROW EXECUTE FUNCTION vpnshop_freeze_payment_intent();

CREATE TABLE "PaymentCase" (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "MerchantAccount"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "objectKey" TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  status "PaymentCaseStatus" NOT NULL DEFAULT 'OPEN',
  priority INTEGER NOT NULL DEFAULT 1,
  "nextCheckAt" TIMESTAMP(3),
  details JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  history JSONB NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX "PaymentCase_accountId_objectKey_kind_key" ON "PaymentCase"("accountId", "objectKey", kind);
CREATE INDEX "PaymentCase_status_nextCheckAt_idx" ON "PaymentCase"(status, "nextCheckAt");

COMMIT;
