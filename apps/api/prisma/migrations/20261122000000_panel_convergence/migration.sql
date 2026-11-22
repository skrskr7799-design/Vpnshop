BEGIN;
ALTER TYPE "JobStatus" ADD VALUE 'CONFIRMED';
ALTER TYPE "JobStatus" ADD VALUE 'RETRY_WAIT';
ALTER TYPE "JobStatus" ADD VALUE 'VERIFY_PENDING';
ALTER TYPE "JobStatus" ADD VALUE 'NEEDS_REVIEW';
ALTER TYPE "JobStatus" ADD VALUE 'SUPERSEDED';
ALTER TABLE "DesiredAssignment" ADD COLUMN "internalSquads" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "FulfillmentJob"
  ADD COLUMN "verificationEpoch" INTEGER NOT NULL DEFAULT 0 CHECK ("verificationEpoch" >= 0),
  ADD COLUMN writes INTEGER NOT NULL DEFAULT 0 CHECK (writes >= 0);

CREATE TABLE "PanelBinding" (
  "subscriptionId" TEXT PRIMARY KEY REFERENCES "Subscription"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "panelInstance" TEXT NOT NULL,
  origin TEXT NOT NULL,
  username TEXT NOT NULL,
  marker TEXT NOT NULL,
  "remoteUserId" BIGINT CHECK ("remoteUserId" BETWEEN 1 AND 9007199254740991),
  "createDispatched" BOOLEAN NOT NULL DEFAULT false,
  "disabledByShop" BOOLEAN NOT NULL DEFAULT false,
  "blockedReason" TEXT,
  "confirmedRevision" INTEGER,
  "confirmedAt" TIMESTAMP(3),
  CHECK (num_nonnulls("confirmedAt", "confirmedRevision") IN (0, 2))
);
CREATE UNIQUE INDEX "PanelBinding_panelInstance_username_key" ON "PanelBinding"("panelInstance",username);
CREATE UNIQUE INDEX "PanelBinding_panelInstance_remoteUserId_key" ON "PanelBinding"("panelInstance","remoteUserId");

CREATE FUNCTION vpnshop_protect_panel_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."subscriptionId", OLD."panelInstance", OLD.origin, OLD.username, OLD.marker)
     IS DISTINCT FROM ROW(NEW."subscriptionId", NEW."panelInstance", NEW.origin, NEW.username, NEW.marker)
     OR (OLD."remoteUserId" IS NOT NULL AND OLD."remoteUserId" IS DISTINCT FROM NEW."remoteUserId")
     OR (OLD."confirmedRevision" IS NOT NULL AND COALESCE(NEW."confirmedRevision", 0) < OLD."confirmedRevision")
  THEN RAISE EXCEPTION 'Panel binding identity and confirmation order are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_panel_binding BEFORE UPDATE ON "PanelBinding"
FOR EACH ROW EXECUTE FUNCTION vpnshop_protect_panel_binding();

CREATE TABLE "PanelObservation" (
  id TEXT PRIMARY KEY,
  "assignmentId" TEXT NOT NULL REFERENCES "DesiredAssignment"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "panelInstance" TEXT NOT NULL,
  revision INTEGER NOT NULL,
  "remoteUserId" BIGINT,
  status TEXT,
  "expiresAt" TIMESTAMP(3),
  "deviceLimit" INTEGER,
  squads TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "observedAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  owner TEXT NOT NULL,
  generation BIGINT NOT NULL,
  comparison TEXT NOT NULL
);
CREATE INDEX "PanelObservation_assignmentId_receivedAt_idx" ON "PanelObservation"("assignmentId","receivedAt");
CREATE TRIGGER freeze_panel_observation BEFORE UPDATE OR DELETE ON "PanelObservation"
FOR EACH ROW EXECUTE FUNCTION vpnshop_immutable_entitlement();

-- Legacy mode stays usable only by the isolated FND-03 regression.
CREATE OR REPLACE FUNCTION vpnshop_require_lease_writer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."assignmentId" IS NOT NULL OR NEW."assignmentId" IS NOT NULL THEN
    IF current_setting('vpnshop.fulfillment_writer', true) = 'revision-v1'
       AND OLD."assignmentId" IS NOT DISTINCT FROM NEW."assignmentId" THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'RUNNING revision requires revision lease protocol';
  END IF;
  IF current_database() <> 'vpnshop_suite' OR current_user <> 'vpnshop_suite'
     OR current_setting('vpnshop.fulfillment_writer', true) IS DISTINCT FROM 'lease-v1' THEN
    RAISE EXCEPTION 'RUNNING job requires fulfillment lease protocol v1 on the disposable database';
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
