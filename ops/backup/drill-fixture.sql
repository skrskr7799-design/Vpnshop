\set ON_ERROR_STOP on
BEGIN;
INSERT INTO "User"(id,email,"emailVerifiedAt","updatedAt") VALUES ('drill-user','drill@example.invalid',now(),now());
INSERT INTO "User"(id,email,role,"updatedAt") VALUES ('drill-admin','drill-admin@example.invalid','ADMIN',now());
INSERT INTO "AuthIdentity"(id,"userId",provider,"providerId","verifiedAt")
  VALUES ('identity','drill-user','EMAIL','drill@example.invalid',now());
INSERT INTO "SessionFamily"(id,"userId","expiresAt") VALUES ('family','drill-user',now()+interval '1 day');
INSERT INTO "Session"(id,"userId","familyId","liveFamilyId","tokenHash","expiresAt")
  VALUES ('web-session','drill-user','family','family','synthetic-web-hash',now()+interval '1 day');
INSERT INTO "AdminSession"(id,"userId","tokenHash","expiresAt","idleExpiresAt")
  VALUES ('staff-session','drill-admin','synthetic-staff-hash',now()+interval '1 day',now()+interval '15 minutes');
INSERT INTO "AdminConfirmation"(id,"sessionId",fingerprint,version,"expiresAt")
  VALUES ('confirmation','staff-session','synthetic-fingerprint',1,now()+interval '2 minutes');
INSERT INTO "Plan"(id,code,name,"deviceLimit") VALUES ('plan','drill-plan','Drill',3);
INSERT INTO "PlanPrice"(id,"planId","durationMonths",currency,amount) VALUES ('price','plan',1,'RUB',10000);
INSERT INTO "OfferVersion"(id,"planPriceId",version,name,"durationMonths","deviceLimit",currency,amount,"publishedAt")
  VALUES ('offer','price',1,'Drill',1,3,'RUB',10000,now());
INSERT INTO "Order"(id,"userId","planId","durationMonths","deviceLimit",currency,amount,"offerVersionId","checkoutKeyHash","checkoutPolicyVersion","expiresAt","updatedAt")
  VALUES ('drill-order','drill-user','plan',1,3,'RUB',10000,'offer','checkout',1,now()+interval '30 minutes',now());
INSERT INTO "MerchantAccount"(id,provider,environment,merchant) VALUES ('merchant','PLATEGA','MOCK','drill-only');
INSERT INTO "Payment"(id,"orderId",provider,status,amount,currency,"accountId","externalId","merchantReference","requestKeyHash",channel,"expiresAt","updatedAt")
  VALUES ('attempt','drill-order','PLATEGA','SUCCEEDED',10000,'RUB','merchant','invoice','reference','key','SBP',now()+interval '30 minutes',now()),
  ('unknown-attempt','drill-order','PLATEGA','UNKNOWN',10000,'RUB','merchant',NULL,'unknown-ref','key-2','SBP',now()+interval '30 minutes',now());
INSERT INTO "PaymentTransaction"(id,"accountId","movementKey",kind,"amountMinor",currency,"providerTime",evidence,"externalPaymentId","merchantReference","paymentId")
  VALUES ('capture','merchant','capture-key','CAPTURE',10000,'RUB',now(),'LOOKUP','invoice','reference','attempt'),
  ('refund','merchant','refund-key','REFUND',2000,'RUB',now(),'LOOKUP','invoice','reference','attempt'),
  ('unallocated','merchant','other-key','CAPTURE',750,'USD',now(),'LOOKUP','unknown-invoice',NULL,NULL);
INSERT INTO "OrderAllocation"(id,"orderId","captureId","createdAt") VALUES ('allocation','drill-order','capture',now());
INSERT INTO "Subscription"(id,"userId",revision) VALUES ('subscription','drill-user',1);
INSERT INTO "PeriodGrant"(id,"subscriptionId","orderId","allocationId",serial,"startAt","endAt","createdAt","calendarVersion","deviceLimit")
  VALUES ('grant','subscription','drill-order','allocation',1,now(),now()+interval '1 month',now(),1,3);
INSERT INTO "ServiceHold"(id,"subscriptionId",source,kind,reason,"createdAt")
  VALUES ('hold','subscription','staff:drill','ADMIN','Synthetic restore hold',now());
INSERT INTO "DesiredAssignment"(id,"subscriptionId",revision,enabled,reason,"createdAt")
  VALUES ('desired','subscription',1,false,'SERVICE_HOLD_ADDED',now());
INSERT INTO "PanelBinding"("subscriptionId","panelInstance",origin,username,marker,"remoteUserId","confirmedRevision","confirmedAt")
  VALUES ('subscription','staging-drill','https://panel.invalid','synthetic-user','synthetic-owner',123,1,now());
INSERT INTO "FulfillmentJob"(id,"assignmentId") VALUES ('job','desired');
SELECT set_config('vpnshop.fulfillment_writer','revision-v1',true);
UPDATE "FulfillmentJob" SET status='RUNNING',"lockedAt"=now() WHERE id='job';
INSERT INTO "FulfillmentLease"("userId",generation,"jobId",owner,"expiresAt")
  VALUES ('drill-user',42,'job','prior-drill-worker',now()+interval '15 minutes');
INSERT INTO "AuditLog"(id,"actorId",action,entity,"entityId") VALUES ('audit','drill-admin','drill.hold','subscription','subscription');
INSERT INTO "SupportCase"(id,"userId","orderId",category,"requestKeyHash",fingerprint,"updatedAt")
  VALUES ('support','drill-user','drill-order','DELIVERY','case-key','fingerprint',now());
INSERT INTO "SupportMessage"(id,"caseId",author,text) VALUES ('message','support','CUSTOMER','Synthetic');
INSERT INTO "RefundIntent"(id,"captureId","commandId","initiatorId","amountMinor",currency,reason,"expiresAt")
  VALUES ('intent','capture','one-refund-command','drill-admin',500,'RUB','Synthetic reserve',now()+interval '1 day');
INSERT INTO "WebhookEvent"(id,provider,"eventKey",payload,"signatureValid","accountId",fingerprint,evidence,"nextCheckAt")
  VALUES ('inbox','PLATEGA','one-callback','{"externalPaymentId":"invoice"}',true,'merchant','drill-event-fingerprint','WEBHOOK',now());
COMMIT;
