\set ON_ERROR_STOP on
BEGIN;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mzt_public,mzt_admin,mzt_worker,mzt_billing,mzt_notifications,mzt_backup,mzt_monitor;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mzt_public,mzt_admin,mzt_worker,mzt_billing,mzt_notifications,mzt_backup,mzt_monitor;
GRANT SELECT (migration_name,finished_at,rolled_back_at) ON "_prisma_migrations"
  TO mzt_public,mzt_admin,mzt_worker,mzt_billing,mzt_notifications,mzt_monitor;

GRANT SELECT ON "User","Plan","PlanPrice","OfferVersion","Order","Payment","OrderAllocation","PaymentTransaction",
   "Subscription","PeriodGrant","Adjustment","ServiceHold","DesiredAssignment","FulfillmentJob","PanelBinding"
  TO mzt_public;
GRANT INSERT ON "User","Order" TO mzt_public;
GRANT EXECUTE ON FUNCTION mzt_lock_offer_plan(text) TO mzt_public;
GRANT EXECUTE ON FUNCTION mzt_lock_order(text) TO mzt_admin,mzt_billing;
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mzt_order_read ON "Order";
CREATE POLICY mzt_order_read ON "Order" FOR SELECT TO mzt_public,mzt_admin,mzt_worker,mzt_billing,mzt_backup USING (true);
DROP POLICY IF EXISTS mzt_order_checkout ON "Order";
CREATE POLICY mzt_order_checkout ON "Order" FOR INSERT TO mzt_public WITH CHECK (
  status = 'PENDING' AND "paidAt" IS NULL AND "fulfilledAt" IS NULL AND "offerVersionId" IS NOT NULL
);
GRANT UPDATE ("email","emailVerifiedAt","emailLoginDisabled","activationRequired","updatedAt") ON "User" TO mzt_public;
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mzt_public_user_read ON "User";
CREATE POLICY mzt_public_user_read ON "User" FOR SELECT TO mzt_public USING (true);
DROP POLICY IF EXISTS mzt_public_user_insert ON "User";
CREATE POLICY mzt_public_user_insert ON "User" FOR INSERT TO mzt_public
  WITH CHECK (role = 'USER' AND status = 'ACTIVE' AND "remnawaveUserId" IS NULL);
DROP POLICY IF EXISTS mzt_public_user_update ON "User";
CREATE POLICY mzt_public_user_update ON "User" FOR UPDATE TO mzt_public USING (role = 'USER') WITH CHECK (role = 'USER');
DROP POLICY IF EXISTS mzt_admin_user ON "User";
CREATE POLICY mzt_admin_user ON "User" TO mzt_admin USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS mzt_read_user ON "User";
CREATE POLICY mzt_read_user ON "User" FOR SELECT TO mzt_worker,mzt_billing,mzt_backup USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "AuthIdentity","Session","SessionFamily","OAuthFlow","IdentityProof",
  "PendingRegistration","AuthMailWindow","VerificationToken" TO mzt_public;
GRANT SELECT, INSERT, UPDATE ON "SupportCase" TO mzt_public;
GRANT SELECT, INSERT ON "SupportMessage","SupportEvent" TO mzt_public;
GRANT SELECT, INSERT, UPDATE ON "SupportReadCursor" TO mzt_public, mzt_admin;
GRANT INSERT ON "NotificationOutbox" TO mzt_admin;
GRANT SELECT (id) ON "NotificationOutbox" TO mzt_admin;
GRANT INSERT ON "NotificationOutbox" TO mzt_public;
GRANT SELECT (id) ON "NotificationOutbox" TO mzt_public;

GRANT SELECT, INSERT, DELETE ON "PendingRegistration" TO mzt_admin;
GRANT UPDATE ("passwordHash","temporaryPasswordExpiresAt") ON "AuthIdentity" TO mzt_admin;
GRANT SELECT (id,"userId",type,"usedAt"), INSERT ON "VerificationToken" TO mzt_admin;
GRANT UPDATE ("usedAt") ON "VerificationToken" TO mzt_admin;
GRANT SELECT, INSERT, UPDATE ON "AuthMailWindow" TO mzt_admin;
GRANT INSERT ON "AuthIdentity" TO mzt_admin;
GRANT SELECT ON "AuthIdentity","Order","MerchantAccount","PaymentTransaction","OrderAllocation","PanelBinding","PanelObservation",
  "WorkerHeartbeat","DesiredAssignment","FulfillmentLease" TO mzt_admin;
GRANT SELECT,INSERT,UPDATE ON "User","StaffCredential","StaffChallenge","StaffInvite","StaffReset","AdminConfirmation","AdminSession",
  "Plan","PlanPrice","OfferVersion","Subscription","ServiceHold","SupportCase","PaymentCase","RefundIntent","AdminOperationalSettings"
  TO mzt_admin;
GRANT SELECT,INSERT,DELETE ON "AdminRecoveryCode","AdminTotp" TO mzt_admin;
GRANT UPDATE ON "AdminTotp","AdminRecoveryCode" TO mzt_admin;
GRANT SELECT,INSERT ON "AuditLog","AdminCommand","SupportMessage","SupportEvent","PeriodGrant" TO mzt_admin;
GRANT SELECT ON "Adjustment" TO mzt_admin;
GRANT SELECT,INSERT,UPDATE ON "FulfillmentJob","DesiredAssignment" TO mzt_admin;
GRANT SELECT, UPDATE ("nextCheckAt","updatedAt") ON "Payment" TO mzt_admin;
GRANT SELECT,UPDATE ON "SessionFamily","Session" TO mzt_admin;
GRANT SELECT,DELETE ON "IdentityProof","OAuthFlow" TO mzt_admin;

GRANT SELECT ON "User","Order","MerchantAccount","PaymentTransaction","OrderAllocation","PeriodGrant","ServiceHold","Adjustment" TO mzt_worker;
GRANT SELECT,UPDATE ON "Subscription" TO mzt_worker;
GRANT SELECT,INSERT ON "DesiredAssignment","PanelObservation","AuditLog" TO mzt_worker;
GRANT SELECT,INSERT,UPDATE ON "FulfillmentJob","FulfillmentLease","PanelBinding" TO mzt_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON "WorkerHeartbeat" TO mzt_worker;

-- Finance is closed. The local process can inspect queue state but cannot create money facts.
GRANT SELECT (status,"nextCheckAt","accountId") ON "Payment" TO mzt_billing;
GRANT SELECT ("processedAt","nextCheckAt","accountId") ON "WebhookEvent" TO mzt_billing;
GRANT SELECT,UPDATE,DELETE ON "NotificationOutbox" TO mzt_notifications;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mzt_backup;

-- This view is the monitor role's only business data surface. It exposes aggregates.
CREATE OR REPLACE VIEW mzt_operational_metrics WITH (security_barrier=true) AS
SELECT
  (SELECT COUNT(*) FROM "FulfillmentJob" j JOIN "DesiredAssignment" d ON d.id=j."assignmentId"
    JOIN "Subscription" s ON s.id=d."subscriptionId" AND s.revision=d.revision
    WHERE j.status IN ('PENDING','RETRY_WAIT','VERIFY_PENDING','NEEDS_REVIEW'))::bigint AS queue_depth,
  COALESCE((SELECT GREATEST(0,EXTRACT(EPOCH FROM (timezone('utc',clock_timestamp())-MIN(j."nextAttemptAt"))))
    FROM "FulfillmentJob" j JOIN "DesiredAssignment" d ON d.id=j."assignmentId"
    JOIN "Subscription" s ON s.id=d."subscriptionId" AND s.revision=d.revision
    WHERE j.status IN ('PENDING','RETRY_WAIT','VERIFY_PENDING') AND j."nextAttemptAt" <= timezone('utc',clock_timestamp())),0)::double precision AS oldest_ready_seconds,
  (SELECT COUNT(*) FROM "FulfillmentLease" WHERE "jobId" IS NOT NULL AND "expiresAt" <= clock_timestamp())::bigint AS expired_leases,
  COALESCE((SELECT GREATEST(0,EXTRACT(EPOCH FROM (timezone('utc',clock_timestamp())-MAX("observedAt"))))
    FROM "WorkerHeartbeat" WHERE ready),-1)::double precision AS worker_heartbeat_age_seconds,
  (SELECT COUNT(*) FROM "Payment" WHERE "accountId" IS NOT NULL AND (status='UNKNOWN' OR
     "nextCheckAt" < timezone('utc',clock_timestamp())))::bigint AS payment_backlog,
  (SELECT COUNT(*) FROM "PaymentTransaction" t LEFT JOIN "OrderAllocation" a ON a."captureId"=t.id
     WHERE t.kind='CAPTURE' AND a.id IS NULL)::bigint AS unallocated_captures,
  (SELECT COUNT(*) FROM "PanelBinding" WHERE "blockedReason" IS NOT NULL)::bigint AS panel_drift,
  COALESCE((SELECT GREATEST(0,EXTRACT(EPOCH FROM (timezone('utc',clock_timestamp())-MAX("observedAt"))))
    FROM "PanelObservation"),-1)::double precision AS panel_observation_age_seconds,
  (SELECT numbackends FROM pg_stat_database WHERE datname=current_database())::bigint AS postgres_connections,
  current_setting('max_connections')::bigint AS postgres_max_connections,
  COALESCE((SELECT GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-last_archived_time))) FROM pg_stat_archiver),-1)::double precision
    AS wal_archive_age_seconds,
  (SELECT failed_count FROM pg_stat_archiver)::bigint AS wal_archive_failures;
GRANT SELECT ON mzt_operational_metrics TO mzt_monitor;

COMMIT;
