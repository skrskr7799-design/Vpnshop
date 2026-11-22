\set ON_ERROR_STOP on
BEGIN;
INSERT INTO "WebhookEvent" SELECT * FROM "WebhookEvent" WHERE id='inbox' ON CONFLICT DO NOTHING;
INSERT INTO "PaymentTransaction" SELECT * FROM "PaymentTransaction" WHERE id='capture' ON CONFLICT DO NOTHING;
INSERT INTO "OrderAllocation" SELECT * FROM "OrderAllocation" WHERE id='allocation' ON CONFLICT DO NOTHING;
INSERT INTO "PeriodGrant" SELECT * FROM "PeriodGrant" WHERE id='grant' ON CONFLICT DO NOTHING;
INSERT INTO "RefundIntent" SELECT * FROM "RefundIntent" WHERE id='intent' ON CONFLICT DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "FulfillmentLease" WHERE "userId"='drill-user' AND generation=43 AND "jobId" IS NULL AND owner IS NULL)
  OR NOT EXISTS (SELECT 1 FROM "FulfillmentJob" WHERE id='job' AND status='VERIFY_PENDING' AND "verificationEpoch"=1)
  OR EXISTS (SELECT 1 FROM "SessionFamily" WHERE "revokedAt" IS NULL)
  OR EXISTS (SELECT 1 FROM "AdminSession" WHERE "revokedAt" IS NULL)
  OR EXISTS (SELECT 1 FROM "AdminConfirmation" WHERE "consumedAt" IS NULL)
  OR NOT EXISTS (SELECT 1 FROM "Payment" WHERE id='unknown-attempt' AND status='UNKNOWN')
  THEN RAISE EXCEPTION 'Restore session, unknown payment or fencing invariant failed'; END IF;
END $$;
COMMIT;
