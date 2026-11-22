\set ON_ERROR_STOP on
\getenv restore_confirm MZT_ISOLATED_RESTORE
SELECT :'restore_confirm' = 'writers-stopped-isolated-target' AS approved \gset
\if :approved
BEGIN;
UPDATE "SessionFamily" SET "revokedAt"=timezone('utc',clock_timestamp()) WHERE "revokedAt" IS NULL;
UPDATE "Session" SET "revokedAt"=timezone('utc',clock_timestamp()) WHERE "revokedAt" IS NULL;
UPDATE "AdminSession" SET "revokedAt"=timezone('utc',clock_timestamp()) WHERE "revokedAt" IS NULL;
UPDATE "VerificationToken" SET "usedAt"=timezone('utc',clock_timestamp()) WHERE "usedAt" IS NULL;
UPDATE "AdminRecoveryCode" SET "usedAt"=timezone('utc',clock_timestamp()) WHERE "usedAt" IS NULL;
UPDATE "AdminConfirmation" SET "consumedAt"=timezone('utc',clock_timestamp()) WHERE "consumedAt" IS NULL;
UPDATE "StaffChallenge" SET "consumedAt"=timezone('utc',clock_timestamp()) WHERE "consumedAt" IS NULL;
UPDATE "StaffInvite" SET "consumedAt"=timezone('utc',clock_timestamp()) WHERE "consumedAt" IS NULL;
UPDATE "StaffReset" SET "expiresAt"=timezone('utc',clock_timestamp()) WHERE "expiresAt" > timezone('utc',clock_timestamp());
DELETE FROM "OAuthFlow";
DELETE FROM "IdentityProof";
DELETE FROM "PendingRegistration";
DELETE FROM "NotificationOutbox";
DELETE FROM "WorkerHeartbeat";
SELECT set_config('vpnshop.fulfillment_writer','revision-v1',true);
UPDATE "FulfillmentJob" SET status='VERIFY_PENDING', "lockedAt"=NULL,
  "nextAttemptAt"=timezone('utc',clock_timestamp()), "verificationEpoch"="verificationEpoch"+1, "lastError"='RESTORE_VERIFY_FIRST'
WHERE "assignmentId" IS NOT NULL AND status IN ('RUNNING','CONFIRMED');
UPDATE "FulfillmentLease" SET generation=generation+1,"jobId"=NULL,owner=NULL,"expiresAt"=NULL WHERE "jobId" IS NOT NULL;
COMMIT;
\else
  DO $$ BEGIN RAISE EXCEPTION 'Isolated restore confirmation required'; END $$;
\endif
