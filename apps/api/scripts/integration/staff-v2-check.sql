DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "StaffCredential" c JOIN "User" u ON u.id=c."userId"
      WHERE u.id='legacy-staff-a' AND u.role='ADMIN' AND c.version=4 AND c."passwordHash"='fixture-unchanged-admin-hash'
      AND c."username"='staff-000000000001' AND c."contactEmail"=u.email)
     OR NOT EXISTS (SELECT 1 FROM "StaffCredential" c JOIN "User" u ON u.id=c."userId"
      WHERE u.id='legacy-staff-b' AND u.role='SUPPORT' AND u.status='BLOCKED' AND c.version=3
      AND c."passwordHash"='fixture-unchanged-support-hash' AND c."username"='staff-000000000002')
     OR NOT EXISTS (SELECT 1 FROM "AdminTotp" WHERE id='legacy-factor' AND "secretEnc"='fixture-encrypted-factor' AND "lastUsedStep"=17)
     OR NOT EXISTS (SELECT 1 FROM "AdminRecoveryCode" WHERE id='legacy-code' AND "codeHash"='fixture-recovery-hash')
     OR NOT EXISTS (SELECT 1 FROM "AuditLog" WHERE id='legacy-audit' AND "actorId"='legacy-staff-a' AND "entityId"='legacy-staff-b')
     OR NOT EXISTS (SELECT 1 FROM "StaffInvite" WHERE id='legacy-invite' AND "issuedBy" IS NULL AND "expiresAt" <= CURRENT_TIMESTAMP)
     OR NOT EXISTS (SELECT 1 FROM "AdminSession" WHERE id='legacy-session' AND "revokedAt" IS NOT NULL)
     OR NOT EXISTS (SELECT 1 FROM "User" WHERE id='legacy-customer' AND NOT "activationRequired" AND email='customer@example.invalid')
     OR EXISTS (SELECT 1 FROM "User" WHERE role='OWNER') THEN
    RAISE EXCEPTION 'PASS 03 legacy identity state changed unexpectedly';
  END IF;
  BEGIN
    UPDATE "StaffCredential" SET "username"='staff-000000000001' WHERE "userId"='legacy-staff-b';
    RAISE EXCEPTION 'Username uniqueness failed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$$;
