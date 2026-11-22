-- One synthetic row per baseline table. Both order and payment carry 10000 minor units.
INSERT INTO "User" (id,email,"remnawaveUserId","updatedAt") VALUES ('u','fixture@example.invalid',73,now());
INSERT INTO "AuthIdentity" (id,"userId",provider,"providerId") VALUES ('i','u','EMAIL','fixture@example.invalid');
INSERT INTO "Session" (id,"userId","familyId","tokenHash","expiresAt") VALUES ('s','u','f','session',now());
INSERT INTO "PendingRegistration" (id,email,"passwordHash","tokenHash","expiresAt") VALUES ('r','new@example.invalid','fixture','registration',now());
INSERT INTO "VerificationToken" (id,"userId",type,"tokenHash","expiresAt") VALUES ('v','u','PASSWORD_RESET','reset',now());
INSERT INTO "AdminTotp" (id,"userId","secretEnc") VALUES ('t','u','fixture');
INSERT INTO "AdminRecoveryCode" (id,"userId","codeHash") VALUES ('c','u','fixture');
INSERT INTO "AdminSession" (id,"userId","tokenHash","idleExpiresAt","expiresAt") VALUES ('a','u','admin',now(),now());
INSERT INTO "Plan" (id,code,name,"deviceLimit") VALUES ('p','legacy','Legacy',3);
INSERT INTO "PlanPrice" (id,"planId","durationMonths",currency,amount) VALUES ('price','p',1,'RUB',10000);
INSERT INTO "Order" (id,"planId","userId","durationMonths","deviceLimit",currency,amount,status,"expiresAt","updatedAt") VALUES ('o','p','u',1,3,'RUB',10000,'PAID',now(),now());
INSERT INTO "Payment" (id,"orderId",provider,"externalId",amount,currency,status,"updatedAt") VALUES ('pay','o','PLATEGA','movement',10000,'RUB','PAID',now());
INSERT INTO "WebhookEvent" (id,provider,"eventKey",payload,"signatureValid") VALUES ('e','PLATEGA','event','{}',true);
INSERT INTO "FulfillmentJob" (id,"orderId","targetExpireAt") VALUES ('j','o','2030-02-28');
INSERT INTO "AuditLog" (id,"actorId",action,entity,"entityId") VALUES ('log','u','fixture','Order','o');
