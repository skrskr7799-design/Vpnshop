-- On the synthetic legacy database. Each subtransaction must reject the invalid row.
DO $$
BEGIN
  BEGIN
    INSERT INTO "FulfillmentJob"(id,"orderId") VALUES ('duplicate','o');
    RAISE EXCEPTION 'Missing unique orderId';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "WebhookEvent"(id,provider,"eventKey",payload,"signatureValid") VALUES ('duplicate','PLATEGA','event','{}',true);
    RAISE EXCEPTION 'Missing provider/eventKey uniqueness';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "FulfillmentJob"(id,"orderId") VALUES ('orphan','absent');
    RAISE EXCEPTION 'Missing order foreign key';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO "Order" (id, "planId", "userId", "durationMonths", "deviceLimit", currency,
      amount, "expiresAt", "updatedAt")
    VALUES ('missing-amount', 'p', 'u', 1, 3, 'RUB', NULL, now(), now());
    RAISE EXCEPTION 'Missing required order amount';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM "OfferVersion") OR EXISTS (
    SELECT 1 FROM "Order" WHERE num_nonnulls("offerVersionId", "checkoutKeyHash", "checkoutPolicyVersion") <> 0
  ) THEN
    RAISE EXCEPTION 'Legacy data acquired invented offer history';
  END IF;
  IF EXISTS (SELECT 1 FROM "PaymentTransaction") OR EXISTS (SELECT 1 FROM "MerchantAccount")
    OR EXISTS (SELECT 1 FROM "Payment" WHERE "accountId" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "WebhookEvent" WHERE "accountId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Legacy finance data acquired invented external proof';
  END IF;
  IF (SELECT count(*) FROM "Subscription" WHERE "legacyUnverified" AND "userId" = 'u' AND revision = 0) <> 1
    OR (SELECT count(*) FROM "Subscription") <> 1
    OR EXISTS (SELECT 1 FROM "OrderAllocation") OR EXISTS (SELECT 1 FROM "PeriodGrant")
    OR EXISTS (SELECT 1 FROM "DesiredAssignment") OR EXISTS (SELECT 1 FROM "FulfillmentJob" WHERE "assignmentId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Legacy subscription must be preserved for review without inferred commerce facts';
  END IF;
  IF (SELECT count(*) FROM "User" u JOIN "Order" o ON o."userId"=u.id
      JOIN "Payment" p ON p."orderId"=o.id JOIN "FulfillmentJob" j ON j."orderId"=o.id
      WHERE u."remnawaveUserId"=73 AND p.amount=o.amount AND o.amount=10000) <> 1 THEN
    RAISE EXCEPTION 'Legacy order chain changed';
  END IF;
END $$;
