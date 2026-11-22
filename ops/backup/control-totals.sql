-- Export internal control evidence to a protected file. No user or provider IDs.
WITH finance AS (
  SELECT t.currency,
    COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CAPTURE'),0) AS captured,
    COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='REFUND'),0) AS refunded,
    COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CHARGEBACK_DEBIT'),0) AS chargeback_debit,
    COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CHARGEBACK_REVERSAL'),0) AS chargeback_reversal,
    COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CAPTURE' AND a.id IS NOT NULL),0) AS allocated,
    COALESCE(SUM(t."amountMinor") FILTER (WHERE t.kind='CAPTURE' AND a.id IS NULL),0) AS unallocated
  FROM "PaymentTransaction" t LEFT JOIN "OrderAllocation" a ON a."captureId"=t.id
  GROUP BY t.currency
)
SELECT jsonb_build_object(
  'finance', COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY currency) FROM finance f), '[]'),
  'users',(SELECT count(*) FROM "User"),
  'identities',(SELECT count(*) FROM "AuthIdentity"),
  'orders',(SELECT count(*) FROM "Order"),
  'payments',(SELECT count(*) FROM "Payment"),
  'ledger',(SELECT count(*) FROM "PaymentTransaction"),
  'allocations',(SELECT count(*) FROM "OrderAllocation"),
  'grants',(SELECT count(*) FROM "PeriodGrant"),
  'grantSeconds',(SELECT COALESCE(sum(EXTRACT(epoch FROM ("endAt"-"startAt"))),0) FROM "PeriodGrant"),
  'holds',(SELECT count(*) FROM "ServiceHold"),
  'desired',(SELECT count(*) FROM "DesiredAssignment"),
  'bindings',(SELECT count(*) FROM "PanelBinding"),
  'adminAudit',(SELECT count(*) FROM "AuditLog"),
  'support',(SELECT count(*) FROM "SupportCase"),
  'messages',(SELECT count(*) FROM "SupportMessage"),
  'webhooks',(SELECT count(*) FROM "WebhookEvent"),
  'jobs',(SELECT count(*) FROM "FulfillmentJob"),
  'refundIntents',(SELECT count(*) FROM "RefundIntent")
);
