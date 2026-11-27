ALTER TYPE "TokenType" ADD VALUE 'VERIFY_EMAIL';
ALTER TABLE "VerificationToken" ADD COLUMN "email" TEXT, ADD COLUMN "familyId" TEXT;

ALTER TYPE "SupportCategory" ADD VALUE 'GENERAL';
ALTER TYPE "SupportCategory" ADD VALUE 'SUBSCRIPTION';
ALTER TYPE "SupportCategory" ADD VALUE 'TECHNICAL';
ALTER TYPE "SupportCategory" ADD VALUE 'ACCOUNT';
ALTER TYPE "SupportStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "SupportStatus" ADD VALUE 'CLOSED';
CREATE TYPE "SupportPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
ALTER TABLE "SupportCase"
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "assigneeId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD COLUMN "priority" "SupportPriority" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "SupportMessage" ADD COLUMN "actorId" TEXT;
ALTER TABLE "SupportEvent" ADD COLUMN "customerVisible" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "SupportCase_assigneeId_createdAt_id_idx" ON "SupportCase"("assigneeId", "createdAt", id);
CREATE TABLE "SupportReadCursor" (
  "caseId" TEXT NOT NULL REFERENCES "SupportCase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "readerId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "seenAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportReadCursor_pkey" PRIMARY KEY ("caseId", "readerId")
);
CREATE INDEX "SupportReadCursor_readerId_idx" ON "SupportReadCursor"("readerId");
