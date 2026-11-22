CREATE TABLE "NotificationOutbox" (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "NotificationOutbox_dueAt_idx" ON "NotificationOutbox"("dueAt");

-- Callers may take the same commerce locks without owning write access to these tables.
CREATE FUNCTION mzt_lock_offer_plan(offer_id text) RETURNS TABLE(id text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT p.id FROM public."Plan" p JOIN public."PlanPrice" price ON price."planId" = p.id
  JOIN public."OfferVersion" v ON v."planPriceId" = price.id WHERE v.id = offer_id FOR SHARE OF p
$$;
CREATE FUNCTION mzt_lock_order(order_id text) RETURNS SETOF public."Order"
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT o.* FROM public."Order" o WHERE o.id = order_id FOR UPDATE
$$;
REVOKE ALL ON FUNCTION mzt_lock_offer_plan(text), mzt_lock_order(text) FROM PUBLIC;
