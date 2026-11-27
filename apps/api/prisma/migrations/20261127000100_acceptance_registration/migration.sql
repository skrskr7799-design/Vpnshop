ALTER TABLE "PendingRegistration"
    ALTER COLUMN "passwordHash" DROP NOT NULL,
    ALTER COLUMN "tokenHash" DROP NOT NULL,
    ADD COLUMN "approvalHash" TEXT;
