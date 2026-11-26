ALTER TABLE "StaffCredential"
  ADD COLUMN "username" TEXT,
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "contactEmail" TEXT,
  ADD COLUMN "temporaryUntil" TIMESTAMP(3),
  ADD COLUMN "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN "deactivatedAt" TIMESTAMP(3);
-- Stable across retries, independent of email, and unique even for historical non-UUID IDs.
WITH ranked AS (
  SELECT "userId", row_number() OVER (ORDER BY "userId" COLLATE "C") AS n FROM "StaffCredential"
)
UPDATE "StaffCredential" c SET "username" = 'staff-' || lpad(ranked.n::text, 12, '0'),
  "contactEmail" = u.email
FROM ranked JOIN "User" u ON u.id = ranked."userId" WHERE c."userId" = ranked."userId";
ALTER TABLE "StaffCredential" ALTER COLUMN "username" SET NOT NULL;
ALTER TABLE "StaffCredential" ADD CONSTRAINT "StaffCredential_username_shape"
  CHECK ("username" COLLATE "C" ~ '^[a-z0-9][a-z0-9._-]{2,47}$');
CREATE UNIQUE INDEX "StaffCredential_username_key" ON "StaffCredential" ("username");
ALTER TABLE "StaffInvite" ADD COLUMN "issuedBy" TEXT;
UPDATE "StaffInvite" SET "expiresAt" = LEAST("expiresAt", CURRENT_TIMESTAMP) WHERE "consumedAt" IS NULL;
UPDATE "StaffReset" SET "expiresAt" = LEAST("expiresAt", CURRENT_TIMESTAMP) WHERE "approvedBy" IS NULL;
ALTER TABLE "StaffChallenge" ADD COLUMN "policy" TEXT NOT NULL DEFAULT 'required';
ALTER TABLE "AdminSession" ADD COLUMN "policy" TEXT NOT NULL DEFAULT 'required',
  ADD COLUMN "factorVerified" BOOLEAN NOT NULL DEFAULT false;
-- Historical sessions and challenges had no factor/policy provenance.
UPDATE "AdminSession" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL;
UPDATE "StaffChallenge" SET "consumedAt" = CURRENT_TIMESTAMP WHERE "consumedAt" IS NULL;
ALTER TABLE "AdminOperationalSettings" ADD COLUMN "twoFactorPolicy" TEXT;
ALTER TABLE "User" ADD COLUMN "activationRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manualActivatedAt" TIMESTAMP(3),
  ADD COLUMN "displayName" TEXT;
ALTER TABLE "AuthIdentity" ADD COLUMN "temporaryPasswordExpiresAt" TIMESTAMP(3);
