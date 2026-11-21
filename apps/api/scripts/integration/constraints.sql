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
    UPDATE "Order" SET amount=NULL WHERE id='o';
    RAISE EXCEPTION 'Missing required order amount';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM "OfferVersion") OR EXISTS (
    SELECT 1 FROM "Order" WHERE num_nonnulls("offerVersionId", "checkoutKeyHash", "checkoutPolicyVersion") <> 0
  ) THEN
    RAISE EXCEPTION 'Legacy data acquired invented offer history';
  END IF;
  IF (SELECT count(*) FROM "User" u JOIN "Order" o ON o."userId"=u.id
      JOIN "Payment" p ON p."orderId"=o.id JOIN "FulfillmentJob" j ON j."orderId"=o.id
      WHERE u."remnawaveUserId"=73 AND p.amount=o.amount AND o.amount=10000) <> 1 THEN
    RAISE EXCEPTION 'Legacy order chain changed';
  END IF;
END $$;
