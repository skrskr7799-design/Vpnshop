CREATE TYPE "SupportCategory" AS ENUM ('PAYMENT', 'DELIVERY', 'ACCESS', 'OTHER');
CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'WAITING_CUSTOMER', 'RESOLVED');
CREATE TYPE "SupportAuthor" AS ENUM ('CUSTOMER', 'STAFF');

CREATE UNIQUE INDEX "Order_id_userId_key" ON "Order"("id", "userId");

CREATE TABLE "SupportCase" (
    "id" TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "orderId" TEXT,
    "category" "SupportCategory" NOT NULL,
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "requestKeyHash" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupportCase_orderId_userId_fkey" FOREIGN KEY ("orderId", "userId")
        REFERENCES "Order"("id", "userId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SupportCase_userId_requestKeyHash_key" ON "SupportCase"("userId", "requestKeyHash");
CREATE INDEX "SupportCase_userId_createdAt_id_idx" ON "SupportCase"("userId", "createdAt", "id");
CREATE INDEX "SupportCase_status_createdAt_id_idx" ON "SupportCase"("status", "createdAt", "id");
CREATE INDEX "SupportCase_orderId_idx" ON "SupportCase"("orderId");

CREATE TABLE "SupportMessage" (
    "id" TEXT PRIMARY KEY,
    "caseId" TEXT NOT NULL REFERENCES "SupportCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "author" "SupportAuthor" NOT NULL,
    "text" TEXT NOT NULL,
    "requestKeyHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupportMessage_text_length" CHECK (char_length("text") BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "SupportMessage_caseId_requestKeyHash_key" ON "SupportMessage"("caseId", "requestKeyHash");
CREATE INDEX "SupportMessage_caseId_createdAt_id_idx" ON "SupportMessage"("caseId", "createdAt", "id");

CREATE TABLE "SupportEvent" (
    "id" TEXT PRIMARY KEY,
    "caseId" TEXT NOT NULL REFERENCES "SupportCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "author" "SupportAuthor" NOT NULL,
    "fromStatus" "SupportStatus" NOT NULL,
    "toStatus" "SupportStatus" NOT NULL,
    "requestKeyHash" TEXT,
    "fingerprint" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SupportEvent_caseId_requestKeyHash_key" ON "SupportEvent"("caseId", "requestKeyHash");
CREATE INDEX "SupportEvent_caseId_createdAt_id_idx" ON "SupportEvent"("caseId", "createdAt", "id");
