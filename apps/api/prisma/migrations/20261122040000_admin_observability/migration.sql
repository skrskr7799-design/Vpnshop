CREATE TABLE "WorkerHeartbeat" (
  id TEXT PRIMARY KEY, "observedAt" TIMESTAMP(3) NOT NULL, ready BOOLEAN NOT NULL
);
CREATE INDEX "WorkerHeartbeat_observedAt_idx" ON "WorkerHeartbeat"("observedAt");
CREATE INDEX "User_role_createdAt_id_idx" ON "User"(role,"createdAt",id);
CREATE INDEX "Order_createdAt_id_idx" ON "Order"("createdAt",id);
CREATE INDEX "FulfillmentJob_createdAt_id_idx" ON "FulfillmentJob"("createdAt",id);
CREATE INDEX "PaymentTransaction_providerTime_idx" ON "PaymentTransaction"("providerTime");
ALTER TABLE "Plan" ADD COLUMN revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "Plan_createdAt_id_idx" ON "Plan"("createdAt",id);
ALTER TABLE "Subscription" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "Subscription_createdAt_id_idx" ON "Subscription"("createdAt",id);
