#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Ignore ambient database URLs (including developers' local .env). Only the newly
# allocated PostgreSQL credentials below are used by Prisma and Vitest.
unset DATABASE_URL TEST_DATABASE_URL PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
tmp=$(mktemp -d)
owned_container=
cleanup() {
  if [[ -n "$owned_container" ]]; then docker rm -f "$owned_container" >/dev/null; fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT
password=$(openssl rand -hex 20)
export VPNSHOP_TEST_MARKER
VPNSHOP_TEST_MARKER=$(openssl rand -hex 16)
if [[ -n "${VPNSHOP_SERVICE_ID:-}" ]]; then
  [[ "${GITHUB_ACTIONS:-}" == true && "$VPNSHOP_SERVICE_ID" =~ ^[a-f0-9]{64}$ ]]
  container=$VPNSHOP_SERVICE_ID
else
  owned_container=$(docker run -d --rm --publish 127.0.0.1::5432 \
    -e "POSTGRES_PASSWORD=$password" -e VPNSHOP_DISPOSABLE=integration \
    postgres:17-alpine@sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32)
  container=$owned_container
fi
[[ "$(docker exec "$container" printenv VPNSHOP_DISPOSABLE)" == integration ]]
port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container")
[[ "$port" =~ ^[0-9]+$ ]]
for _ in {1..45}; do
  if docker exec "$container" pg_isready -h 127.0.0.1 -q; then break; fi
  sleep 1
done
sql() { docker exec -i "$container" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$1"; }
# CREATE fails on reuse. The setup never adopts existing databases or roles.
sql postgres <<SQL
CREATE ROLE vpnshop_migrator LOGIN PASSWORD '$password';
CREATE ROLE vpnshop_suite LOGIN PASSWORD '$VPNSHOP_TEST_MARKER';
CREATE DATABASE vpnshop_suite OWNER vpnshop_migrator;
CREATE DATABASE vpnshop_legacy OWNER vpnshop_migrator;
REVOKE ALL ON DATABASE vpnshop_suite, vpnshop_legacy FROM PUBLIC;
GRANT CONNECT ON DATABASE vpnshop_suite TO vpnshop_suite;
SQL
base="postgresql://vpnshop_migrator:$password@127.0.0.1:$port"
export DATABASE_URL="$base/vpnshop_suite"
pnpm exec prisma migrate deploy
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code

# Build the pre-migration catalog independently from the versioned baseline SQL.
# This blob belongs to apps/api/prisma/schema.prisma at the accepted FND-01 commit.
git show 43dd45835c2280c6ee831c0a3ca0f96f151a8ae2:apps/api/prisma/schema.prisma > "$tmp/legacy.prisma"
export DATABASE_URL="$base/vpnshop_legacy"
pnpm exec prisma migrate diff --from-empty --to-schema-datamodel "$tmp/legacy.prisma" --script > "$tmp/legacy.sql"
sql vpnshop_legacy < <(printf 'SET ROLE vpnshop_migrator;\n'; cat "$tmp/legacy.sql")
sql vpnshop_legacy < scripts/integration/legacy.sql
legacy_diff() {
  pnpm exec prisma migrate diff --from-schema-datasource "$tmp/legacy.prisma" --to-schema-datamodel "$tmp/legacy.prisma" --exit-code
}
# Prove a drifted legacy fixture stops before recording any migration history.
sql vpnshop_legacy <<< 'CREATE INDEX fnd02_drift_probe ON "Order"(amount)'
drift_status=0
legacy_diff || drift_status=$?
[[ "$drift_status" == 2 ]]
sql vpnshop_legacy <<< 'DROP INDEX fnd02_drift_probe'
legacy_diff

snapshot() {
  # Project Order onto its legacy columns. The new nullable fields are checked separately.
  {
    docker exec "$container" pg_dump -U postgres -d vpnshop_legacy --data-only --schema=public \
      --exclude-table=public._prisma_migrations --exclude-table='public."Subscription"' --exclude-table='public."FulfillmentJob"' --exclude-table='public."Order"' --exclude-table='public."Payment"' --exclude-table='public."WebhookEvent"' --inserts --no-owner --no-privileges |
      sed -n '/^INSERT INTO /p'
    sql vpnshop_legacy <<'SQL'
COPY (SELECT id, "userId", "planId", "durationMonths", "deviceLimit", currency, amount,
  status, "expiresAt", "paidAt", "fulfilledAt", "createdAt", "updatedAt" FROM "Order") TO STDOUT;
COPY (SELECT id, "orderId", provider, "externalId", status, amount, currency, "providerData",
  "paidAt", "createdAt", "updatedAt" FROM "Payment") TO STDOUT;
COPY (SELECT id, provider, "eventKey", payload, "signatureValid", "receivedAt", "processedAt", error
  FROM "WebhookEvent") TO STDOUT;
COPY (SELECT id, "orderId", status, attempts, "nextAttemptAt", "targetExpireAt", "lockedAt",
  "lastError", "completedAt", "createdAt" FROM "FulfillmentJob") TO STDOUT;
SQL
  } | LC_ALL=C sort
}
snapshot > "$tmp/before"
[[ "$(wc -l < "$tmp/before")" -eq 15 ]]
pnpm exec prisma migrate resolve --applied 20261121000000_baseline
for pass in 1 2; do
  pnpm exec prisma migrate deploy
  pnpm exec prisma migrate status
  pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
  # Re-execute the exact idempotent DML from the migration.
  awk '/^-- BEGIN legacy subscription backfill$/{copy=1; next}
       /^-- END legacy subscription backfill$/{copy=0} copy'     prisma/migrations/20261121040000_subscription_allocation/migration.sql > "$tmp/subscription-backfill.sql"
  [[ -s "$tmp/subscription-backfill.sql" ]]
  sql vpnshop_legacy < "$tmp/subscription-backfill.sql"
  sql vpnshop_legacy < scripts/integration/constraints.sql
  snapshot > "$tmp/after"
  cmp "$tmp/before" "$tmp/after"
  echo "Legacy pass $pass: 15 fixture rows preserved, sha256 $(sha256sum "$tmp/after" | cut -d' ' -f1)" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
done
# Only the runtime schema is writable, with DML privileges on application tables.
sql vpnshop_suite <<SQL
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA test_guard;
CREATE TABLE test_guard.instance (marker text PRIMARY KEY);
INSERT INTO test_guard.instance VALUES ('$VPNSHOP_TEST_MARKER');
GRANT USAGE ON SCHEMA test_guard, public TO vpnshop_suite;
GRANT SELECT ON test_guard.instance TO vpnshop_suite;
GRANT SELECT, INSERT, UPDATE, DELETE ON "User","AuthIdentity","Session","PendingRegistration",
  "VerificationToken","AdminTotp","AdminRecoveryCode","AdminSession","Plan","PlanPrice","OfferVersion","Order",
  "Payment","WebhookEvent","FulfillmentJob","FulfillmentLease","AuditLog","MerchantAccount","PaymentCase" TO vpnshop_suite;
-- TRUNCATE permits guarded suite reset without allowing ledger UPDATE/DELETE.
GRANT SELECT, INSERT, TRUNCATE ON "PaymentTransaction", "OrderAllocation", "PeriodGrant",
  "Adjustment", "DesiredAssignment" TO vpnshop_suite;
GRANT SELECT, INSERT, UPDATE, TRUNCATE ON "ServiceHold", "Subscription" TO vpnshop_suite;
GRANT TRUNCATE ON "FulfillmentLease", "FulfillmentJob" TO vpnshop_suite;
GRANT SELECT, INSERT, UPDATE, TRUNCATE ON "PanelBinding" TO vpnshop_suite;
GRANT SELECT, INSERT, TRUNCATE ON "PanelObservation" TO vpnshop_suite;
SQL
export TEST_DATABASE_URL="postgresql://vpnshop_suite:$VPNSHOP_TEST_MARKER@127.0.0.1:$port/vpnshop_suite"
export DATABASE_URL="$TEST_DATABASE_URL"
vitest_status=0
pnpm exec vitest run --config vitest.integration.config.ts --reporter=default --reporter=json --outputFile.json="$tmp/tests.json" || vitest_status=$?
node scripts/integration/check-results.mjs "$tmp/tests.json" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit "$vitest_status"
