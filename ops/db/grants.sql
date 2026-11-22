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
GRANT UPDATE ("email","emailVerifiedAt","emailLoginDisabled","updatedAt") ON "User" TO mzt_public;
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
GRANT INSERT ON "NotificationOutbox" TO mzt_public;
GRANT SELECT (id) ON "NotificationOutbox" TO mzt_public;

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
COMMIT;
