INSERT INTO "Subscription" (id, "userId", "legacyUnverified")
SELECT 'legacy:' || u.id, u.id, true
FROM "User" u
WHERE u."remnawaveUserId" IS NOT NULL OR EXISTS (
  SELECT 1 FROM "Order" o WHERE o."userId" = u.id AND o.status IN ('PAID', 'FULFILLED')
)
ON CONFLICT ("userId") DO NOTHING;
