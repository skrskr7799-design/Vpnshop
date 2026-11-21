BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE "OrderAllocation" (
  id TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "captureId" TEXT NOT NULL REFERENCES "PaymentTransaction"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "OrderAllocation_orderId_key" ON "OrderAllocation"("orderId");
CREATE UNIQUE INDEX "OrderAllocation_captureId_key" ON "OrderAllocation"("captureId");

CREATE TABLE "Subscription" (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "legacyUnverified" BOOLEAN NOT NULL DEFAULT false,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  "nextBoundaryAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");
CREATE INDEX "Subscription_nextBoundaryAt_idx" ON "Subscription"("nextBoundaryAt");

CREATE TABLE "PeriodGrant" (
  id TEXT PRIMARY KEY,
  "subscriptionId" TEXT NOT NULL REFERENCES "Subscription"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "orderId" TEXT NOT NULL REFERENCES "Order"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "allocationId" TEXT NOT NULL REFERENCES "OrderAllocation"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  serial INTEGER NOT NULL CHECK (serial > 0),
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "calendarVersion" INTEGER NOT NULL CHECK ("calendarVersion" > 0),
  "deviceLimit" INTEGER NOT NULL CHECK ("deviceLimit" > 0),
  CHECK ("startAt" < "endAt"),
  EXCLUDE USING gist ("subscriptionId" WITH =, tsrange("startAt", "endAt", '[)') WITH &&)
);
CREATE UNIQUE INDEX "PeriodGrant_orderId_key" ON "PeriodGrant"("orderId");
CREATE UNIQUE INDEX "PeriodGrant_allocationId_key" ON "PeriodGrant"("allocationId");
CREATE UNIQUE INDEX "PeriodGrant_subscriptionId_serial_key" ON "PeriodGrant"("subscriptionId", serial);

CREATE TABLE "Adjustment" (
  id TEXT PRIMARY KEY,
  "grantId" TEXT NOT NULL REFERENCES "PeriodGrant"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "movementId" TEXT NOT NULL REFERENCES "PaymentTransaction"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "effectiveAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  reason TEXT NOT NULL
);
CREATE UNIQUE INDEX "Adjustment_grantId_key" ON "Adjustment"("grantId");
CREATE UNIQUE INDEX "Adjustment_movementId_key" ON "Adjustment"("movementId");

CREATE TABLE "ServiceHold" (
  id TEXT PRIMARY KEY,
  "subscriptionId" TEXT NOT NULL REFERENCES "Subscription"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  source TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CHARGEBACK', 'FRAUD', 'ADMIN', 'SERVICE_CONFLICT')),
  reason TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "createdBy" TEXT,
  "movementId" TEXT REFERENCES "PaymentTransaction"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "releasedAt" TIMESTAMP(3),
  "releasedBy" TEXT,
  "releaseMovementId" TEXT REFERENCES "PaymentTransaction"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ServiceHold_subscriptionId_source_key" ON "ServiceHold"("subscriptionId", source);
CREATE UNIQUE INDEX "ServiceHold_movementId_key" ON "ServiceHold"("movementId");
CREATE UNIQUE INDEX "ServiceHold_releaseMovementId_key" ON "ServiceHold"("releaseMovementId");

CREATE TABLE "DesiredAssignment" (
  id TEXT PRIMARY KEY,
  "subscriptionId" TEXT NOT NULL REFERENCES "Subscription"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  "grantId" TEXT REFERENCES "PeriodGrant"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  enabled BOOLEAN NOT NULL,
  "deviceLimit" INTEGER,
  "expiresAt" TIMESTAMP(3),
  "nextBoundaryAt" TIMESTAMP(3),
  reason TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  CHECK ((enabled AND num_nonnulls("grantId", "deviceLimit", "expiresAt") = 3)
    OR (NOT enabled AND num_nonnulls("grantId", "deviceLimit", "expiresAt") = 0))
);
CREATE UNIQUE INDEX "DesiredAssignment_subscriptionId_revision_key" ON "DesiredAssignment"("subscriptionId", revision);

ALTER TABLE "FulfillmentJob"
  ALTER COLUMN "orderId" DROP NOT NULL,
  ADD COLUMN "assignmentId" TEXT REFERENCES "DesiredAssignment"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FulfillmentJob_exactly_one_target" CHECK (num_nonnulls("orderId", "assignmentId") = 1);
CREATE UNIQUE INDEX "FulfillmentJob_assignmentId_key" ON "FulfillmentJob"("assignmentId");

CREATE FUNCTION vpnshop_validate_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PaymentTransaction" f
    JOIN "Payment" p ON p.id = f."paymentId"
    JOIN "Order" o ON o.id = p."orderId"
    JOIN "MerchantAccount" a ON a.id = f."accountId"
    WHERE f.id = NEW."captureId" AND o.id = NEW."orderId" AND o.status = 'PENDING'
      AND o."offerVersionId" IS NOT NULL AND f.kind = 'CAPTURE' AND p.status = 'SUCCEEDED'
      AND f."accountId" = p."accountId" AND a.provider = p.provider
      AND f."externalPaymentId" = p."externalId" AND f."merchantReference" = p."merchantReference"
      AND f."amountMinor" = o.amount AND p.amount = o.amount
      AND f.currency = o.currency::text AND p.currency = o.currency
      AND f."providerTime" >= o."createdAt" AND f."providerTime" < o."expiresAt"
  ) THEN
    RAISE EXCEPTION 'Allocation requires verified matching capture';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_allocation BEFORE INSERT ON "OrderAllocation"
FOR EACH ROW EXECUTE FUNCTION vpnshop_validate_allocation();

CREATE FUNCTION vpnshop_validate_period() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "OrderAllocation" a
    JOIN "Order" o ON o.id = a."orderId"
    JOIN "Subscription" s ON s.id = NEW."subscriptionId" AND s."userId" = o."userId"
    WHERE a.id = NEW."allocationId" AND a."orderId" = NEW."orderId"
      AND o."deviceLimit" = NEW."deviceLimit" AND NOT s."legacyUnverified"
  ) THEN
    RAISE EXCEPTION 'Period requires a matching allocation, subscription and snapshot';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_period BEFORE INSERT ON "PeriodGrant"
FOR EACH ROW EXECUTE FUNCTION vpnshop_validate_period();

CREATE FUNCTION vpnshop_protect_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Service hold history is immutable'; END IF;
  IF (to_jsonb(NEW) - ARRAY['releasedAt', 'releasedBy', 'releaseMovementId']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['releasedAt', 'releasedBy', 'releaseMovementId'])
     OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL
     OR NEW."releasedAt" < NEW."createdAt" THEN
    RAISE EXCEPTION 'Service hold only permits its first release';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_hold BEFORE UPDATE OR DELETE ON "ServiceHold"
FOR EACH ROW EXECUTE FUNCTION vpnshop_protect_hold();

CREATE FUNCTION vpnshop_immutable_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Allocation, period and assignment history is immutable';
END;
$$;
CREATE TRIGGER freeze_allocation BEFORE UPDATE OR DELETE ON "OrderAllocation"
FOR EACH ROW EXECUTE FUNCTION vpnshop_immutable_entitlement();
CREATE TRIGGER freeze_period BEFORE UPDATE OR DELETE ON "PeriodGrant"
FOR EACH ROW EXECUTE FUNCTION vpnshop_immutable_entitlement();
CREATE TRIGGER freeze_adjustment BEFORE UPDATE OR DELETE ON "Adjustment"
FOR EACH ROW EXECUTE FUNCTION vpnshop_immutable_entitlement();
CREATE TRIGGER freeze_assignment BEFORE UPDATE OR DELETE ON "DesiredAssignment"
FOR EACH ROW EXECUTE FUNCTION vpnshop_immutable_entitlement();

-- Legacy protocol can exercise its regressions only on the disposable CI database.
-- No worker in COM-03 can promote a revision job to RUNNING.
CREATE OR REPLACE FUNCTION vpnshop_require_lease_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."assignmentId" IS NOT NULL OR NEW."assignmentId" IS NOT NULL
     OR current_database() <> 'vpnshop_suite' OR current_user <> 'vpnshop_suite'
     OR current_setting('vpnshop.fulfillment_writer', true) IS DISTINCT FROM 'lease-v1' THEN
    RAISE EXCEPTION 'RUNNING job requires fulfillment lease protocol v1 on the disposable database';
  END IF;
  RETURN NEW;
END;
$$;

-- BEGIN legacy subscription backfill
INSERT INTO "Subscription" (id, "userId", "legacyUnverified")
SELECT 'legacy:' || u.id, u.id, true
FROM "User" u
WHERE u."remnawaveUserId" IS NOT NULL OR EXISTS (
  SELECT 1 FROM "Order" o WHERE o."userId" = u.id AND o.status IN ('PAID', 'FULFILLED')
)
ON CONFLICT ("userId") DO NOTHING;
-- END legacy subscription backfill

COMMIT;
