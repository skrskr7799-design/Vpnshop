CREATE TABLE "StaffCredential" (
  "userId" TEXT PRIMARY KEY REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "passwordHash" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE "StaffChallenge" (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version INTEGER NOT NULL, stage TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3)
);
CREATE INDEX "StaffChallenge_userId_expiresAt_idx" ON "StaffChallenge"("userId","expiresAt");
CREATE TABLE "StaffInvite" (
  id TEXT PRIMARY KEY, email TEXT NOT NULL, role "UserRole" NOT NULL, "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "StaffInvite_tokenHash_key" ON "StaffInvite"("tokenHash");
CREATE INDEX "StaffInvite_email_expiresAt_idx" ON "StaffInvite"(email,"expiresAt");
CREATE TABLE "StaffReset" (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId" TEXT NOT NULL, version INTEGER NOT NULL, "caseId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "approvedBy" TEXT
);
CREATE INDEX "StaffReset_userId_expiresAt_idx" ON "StaffReset"("userId","expiresAt");
CREATE TABLE "AdminConfirmation" (
  id TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL REFERENCES "AdminSession"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  fingerprint TEXT NOT NULL, version INTEGER NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3)
);
CREATE INDEX "AdminConfirmation_sessionId_expiresAt_idx" ON "AdminConfirmation"("sessionId","expiresAt");
CREATE TABLE "AdminCommand" (
  id TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, operation TEXT NOT NULL, permission TEXT NOT NULL,
  "targetId" TEXT NOT NULL, "keyHash" TEXT NOT NULL, fingerprint TEXT NOT NULL,
  result JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AdminCommand_actorId_operation_targetId_keyHash_key" ON "AdminCommand"("actorId",operation,"targetId","keyHash");
ALTER TABLE "AuditLog" ADD COLUMN role TEXT, ADD COLUMN permission TEXT, ADD COLUMN reason TEXT,
  ADD COLUMN "commandId" TEXT, ADD COLUMN "correlationId" TEXT, ADD COLUMN outcome TEXT;
CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt",id);

-- Only dedicated staff principals are eligible. Mixed historical accounts require a new
-- staff identity and a controlled review of the original account.
INSERT INTO "StaffCredential" ("userId","passwordHash")
SELECT u.id, a."passwordHash" FROM "User" u JOIN "AuthIdentity" a ON a."userId" = u.id
WHERE u.role IN ('ADMIN','SUPPORT') AND a.provider = 'EMAIL' AND a."passwordHash" IS NOT NULL
  AND a."verifiedAt" IS NOT NULL AND a."providerId" = u.email
  AND NOT EXISTS (SELECT 1 FROM "Order" o WHERE o."userId" = u.id)
  AND NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."userId" = u.id)
  AND NOT EXISTS (SELECT 1 FROM "SupportCase" c WHERE c."userId" = u.id)
  AND NOT EXISTS (SELECT 1 FROM "AuthIdentity" i WHERE i."userId" = u.id AND i.provider <> 'EMAIL')
ON CONFLICT DO NOTHING;

-- Revoke prior staff cookies. Existing TOTP enrollment and recovery history are preserved.
UPDATE "AdminSession" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL;

-- Audit is append-only, including for privileged application clients. The disposable suite
-- clears it by TRUNCATE after validating its independent database marker.
CREATE FUNCTION vpnshop_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only';
END $$;
CREATE TRIGGER vpnshop_audit_append_only BEFORE UPDATE OR DELETE ON "AuditLog"
FOR EACH ROW EXECUTE FUNCTION vpnshop_audit_append_only();
