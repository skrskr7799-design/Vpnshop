BEGIN;
ALTER TABLE "User" ADD COLUMN "emailLoginDisabled" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "SessionFamily" (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3)
);
CREATE INDEX "SessionFamily_userId_revokedAt_expiresAt_idx" ON "SessionFamily"("userId", "revokedAt", "expiresAt");
ALTER TABLE "Session" ADD COLUMN "liveFamilyId" TEXT REFERENCES "SessionFamily"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "Session_live_family_matches" CHECK ("liveFamilyId" IS NULL OR "liveFamilyId" = "familyId");
CREATE TABLE "OAuthFlow" (
  state TEXT PRIMARY KEY, provider TEXT NOT NULL, "browserHash" TEXT NOT NULL, verifier TEXT NOT NULL,
  nonce TEXT, "returnTo" TEXT, mode TEXT NOT NULL, "familyId" TEXT REFERENCES "SessionFamily"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  target "AuthProvider", purpose TEXT, "requestKeyHash" TEXT, fingerprint TEXT, "proofId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "OAuthFlow_familyId_provider_requestKeyHash_key" ON "OAuthFlow"("familyId", provider, "requestKeyHash");
CREATE INDEX "OAuthFlow_expiresAt_idx" ON "OAuthFlow"("expiresAt");
CREATE TABLE "IdentityProof" (
  id TEXT PRIMARY KEY, "familyId" TEXT NOT NULL REFERENCES "SessionFamily"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  target "AuthProvider" NOT NULL, purpose TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "usedAt" TIMESTAMP(3)
);
CREATE INDEX "IdentityProof_familyId_expiresAt_idx" ON "IdentityProof"("familyId", "expiresAt");
CREATE TABLE "AuthMailWindow" (key TEXT PRIMARY KEY, "startedAt" TIMESTAMP(3) NOT NULL, count INTEGER NOT NULL);
COMMIT;
