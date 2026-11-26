INSERT INTO "User"(id,email,role,status,"updatedAt") VALUES
  ('legacy-staff-a','shared@example.invalid','ADMIN','ACTIVE',now()),
  ('legacy-staff-b','shared@other.invalid','SUPPORT','BLOCKED',now()),
  ('legacy-customer','customer@example.invalid','USER','ACTIVE',now());
INSERT INTO "StaffCredential"("userId","passwordHash",version) VALUES
  ('legacy-staff-a','fixture-unchanged-admin-hash',4), ('legacy-staff-b','fixture-unchanged-support-hash',3);
INSERT INTO "AdminTotp"(id,"userId","secretEnc","confirmedAt","lastUsedStep")
VALUES ('legacy-factor','legacy-staff-a','fixture-encrypted-factor',now(),17);
INSERT INTO "AdminRecoveryCode"(id,"userId","codeHash") VALUES ('legacy-code','legacy-staff-a','fixture-recovery-hash');
INSERT INTO "AuditLog"(id,"actorId",action,entity,"entityId")
VALUES ('legacy-audit','legacy-staff-a','fixture-action','staff','legacy-staff-b');
INSERT INTO "AdminSession"(id,"userId","tokenHash","idleExpiresAt","expiresAt")
VALUES ('legacy-session','legacy-staff-a','fixture-session',now()+interval '1 hour',now()+interval '2 hours');
