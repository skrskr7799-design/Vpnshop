CREATE TABLE "FulfillmentLease" (
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "generation" BIGINT NOT NULL,
  "jobId" TEXT,
  "owner" TEXT,
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "FulfillmentLease_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "FulfillmentLease_active" CHECK (
    num_nonnulls("jobId", "owner", "expiresAt") IN (0, 3)
  )
);

-- Deployment interlock for the previous API's claim, reaper and completion code.
-- Transaction-local protocol marker. Ownership is checked separately in the queue.
CREATE FUNCTION vpnshop_require_lease_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('vpnshop.fulfillment_writer', true) IS DISTINCT FROM 'lease-v1' THEN
    RAISE EXCEPTION 'RUNNING job requires fulfillment lease protocol v1';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fulfillment_require_lease_writer
BEFORE UPDATE ON "FulfillmentJob"
FOR EACH ROW WHEN (OLD.status = 'RUNNING' OR NEW.status = 'RUNNING')
EXECUTE FUNCTION vpnshop_require_lease_writer();
