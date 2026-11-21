BEGIN;

CREATE TABLE "OfferVersion" (
  "id" TEXT PRIMARY KEY,
  "planPriceId" TEXT NOT NULL REFERENCES "PlanPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "name" TEXT NOT NULL,
  "durationMonths" INTEGER NOT NULL CHECK ("durationMonths" BETWEEN 1 AND 36),
  "deviceLimit" INTEGER NOT NULL CHECK ("deviceLimit" BETWEEN 1 AND 100),
  "currency" "Currency" NOT NULL,
  "amount" INTEGER NOT NULL CHECK ("amount" BETWEEN 1 AND 100000000),
  "publishedAt" TIMESTAMP(3) NOT NULL,
  "withdrawnAt" TIMESTAMP(3),
  CONSTRAINT "OfferVersion_withdrawal_time" CHECK ("withdrawnAt" >= "publishedAt")
);
CREATE UNIQUE INDEX "OfferVersion_planPriceId_version_key" ON "OfferVersion"("planPriceId", "version");
CREATE UNIQUE INDEX "OfferVersion_one_current" ON "OfferVersion"("planPriceId") WHERE "withdrawnAt" IS NULL;

ALTER TABLE "Order"
  ADD COLUMN "offerVersionId" TEXT REFERENCES "OfferVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN "checkoutKeyHash" TEXT,
  ADD COLUMN "checkoutPolicyVersion" INTEGER,
  ADD CONSTRAINT "Order_checkout_metadata" CHECK (num_nonnulls("offerVersionId", "checkoutKeyHash", "checkoutPolicyVersion") IN (0, 3));
CREATE UNIQUE INDEX "Order_userId_checkoutKeyHash_key" ON "Order"("userId", "checkoutKeyHash");
CREATE INDEX "Order_offerVersionId_idx" ON "Order"("offerVersionId");

CREATE FUNCTION vpnshop_freeze_offer_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'withdrawnAt') IS DISTINCT FROM (to_jsonb(OLD) - 'withdrawnAt')
     OR (OLD."withdrawnAt" IS NOT NULL AND NEW."withdrawnAt" IS DISTINCT FROM OLD."withdrawnAt") THEN
    RAISE EXCEPTION 'Published offer terms are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER freeze_offer_version BEFORE UPDATE ON "OfferVersion"
FOR EACH ROW EXECUTE FUNCTION vpnshop_freeze_offer_version();

CREATE FUNCTION vpnshop_freeze_order_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW."userId", NEW."planId", NEW."durationMonths", NEW."deviceLimit", NEW.currency, NEW.amount,
         NEW."expiresAt", NEW."createdAt", NEW."offerVersionId", NEW."checkoutKeyHash", NEW."checkoutPolicyVersion")
     IS DISTINCT FROM
     ROW(OLD.id, OLD."userId", OLD."planId", OLD."durationMonths", OLD."deviceLimit", OLD.currency, OLD.amount,
         OLD."expiresAt", OLD."createdAt", OLD."offerVersionId", OLD."checkoutKeyHash", OLD."checkoutPolicyVersion") THEN
    RAISE EXCEPTION 'Order snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER freeze_order_snapshot BEFORE UPDATE ON "Order"
FOR EACH ROW EXECUTE FUNCTION vpnshop_freeze_order_snapshot();

COMMIT;
