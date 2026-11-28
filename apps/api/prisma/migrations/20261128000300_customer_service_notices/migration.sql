CREATE TABLE "CustomerNotice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "CustomerNotice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerNotice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CustomerNotice_userId_createdAt_id_idx" ON "CustomerNotice"("userId", "createdAt", "id");
CREATE INDEX "CustomerNotice_userId_readAt_idx" ON "CustomerNotice"("userId", "readAt");
