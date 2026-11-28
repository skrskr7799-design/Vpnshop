CREATE INDEX "User_role_displayName_createdAt_id_idx" ON "User"("role", "displayName", "createdAt", "id");
CREATE INDEX "Payment_externalId_idx" ON "Payment"("externalId");
CREATE INDEX "Payment_merchantReference_idx" ON "Payment"("merchantReference");
