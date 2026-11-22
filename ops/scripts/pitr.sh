#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
db_image=${MZT_DRILL_DB_IMAGE:-mzt-ci-db:$revision}
migrator=${MZT_DRILL_MIGRATOR_IMAGE:-mzt-ci-migrator:$revision}
tmp=$(mktemp -d)
scope="mzt-pitr-${tmp##*.}"
pg="$scope-primary"
restored="$scope-restored"
network="$scope-closed"
repo="$scope-repo"
state="$scope-primary-data"
recovered="$scope-restored-data"
cleanup() {
  docker rm -f "$pg" "$restored" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$repo" "$state" "$recovered" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
umask 077
openssl rand -hex 32 > "$tmp/pgpass"
printf 'postgresql://postgres:%s@pitr-db:5432/postgres\n' "$(cat "$tmp/pgpass")" > "$tmp/migrator_url"
cat > "$tmp/pgbackrest_conf" <<CONF
[vpnshop]
pg1-path=/state/db/pgdata
pg1-socket-path=/var/run/postgresql
[global]
repo1-path=/state/repo
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$(openssl rand -base64 36 | tr -d '\n')
repo1-retention-full=2
start-fast=y
archive-timeout=60
lock-path=/tmp/pgbackrest
log-level-console=warn
log-level-file=off
CONF
chmod a+r "$tmp/pgpass" "$tmp/migrator_url" "$tmp/pgbackrest_conf"
docker network create --internal "$network" >/dev/null
for name in "$repo" "$state" "$recovered"; do
  ! docker volume inspect "$name" >/dev/null 2>&1
  docker volume create "$name" >/dev/null
done
common=(--user 999:999 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:mode=1777
  --tmpfs /var/run/postgresql:mode=1777 -v "$tmp/pgbackrest_conf:/run/secrets/pgbackrest_conf:ro")
archive='pgbackrest --config=/run/secrets/pgbackrest_conf --stanza=vpnshop archive-push %p'
docker run -d --name "$pg" --network "$network" --network-alias pitr-db "${common[@]}" \
  -v "$repo:/state/repo" -v "$state:/state/db" -v "$tmp/pgpass:/run/secrets/drill_pgpass:ro" \
  --entrypoint sh "$db_image" -ec 'initdb --auth-local=trust --auth-host=scram-sha-256 --username=postgres --pwfile=/run/secrets/drill_pgpass --data-checksums >/dev/null
    exec postgres -c listen_addresses="*" -c archive_mode=on -c archive_timeout=30 -c "archive_command=$1"' sh "$archive" >/dev/null
ready() {
  for i in {1..45}; do if docker exec "$1" pg_isready -U postgres -q; then return; fi; sleep 1; done
  docker logs --tail 20 "$1"; return 1
}
sql() { local container=$1; shift; docker exec -i "$container" psql -X -qAt --set=ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
br() { docker exec "$pg" pgbackrest --config=/run/secrets/pgbackrest_conf --stanza=vpnshop "$@"; }
ready "$pg"
if [[ "${MZT_DRILL_SQL_ONLY:-0}" == 1 ]]; then
  echo 'Using migration SQL locally. Prisma migration history is verified only in the CI variant.'
  for file in apps/api/prisma/migrations/*/migration.sql; do sql "$pg" < "$file" >/dev/null; done
else
  docker run --rm --network "$network" --read-only --tmpfs /tmp:mode=1777 --cap-drop ALL --security-opt no-new-privileges \
    --user 1000:1000 -e HOME=/tmp -v "$tmp/migrator_url:/run/secrets/migrator_url:ro" --entrypoint sh "$migrator" -ec \
    'export DATABASE_URL="$(cat /run/secrets/migrator_url)"; cd /app/apps/api; pnpm exec prisma migrate deploy; pnpm exec prisma migrate status'
  sql "$pg" -c 'SELECT migration_name||'"'"':'"'"'||checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$tmp/history.before"
fi
sql "$pg" < ops/backup/drill-fixture.sql >/dev/null
br stanza-create
br check
br --type=full backup
br verify
# Transaction strictly between the base backup and the chosen target.
sql "$pg" -c "INSERT INTO \"AuditLog\"(id,action,entity) VALUES ('pitr-before-target','drill.target','drill')"
target=$(sql "$pg" -c "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")
sql "$pg" < ops/backup/control-totals.sql > "$tmp/before"
sleep .1
sql "$pg" -c "INSERT INTO \"AuditLog\"(id,action,entity) VALUES ('pitr-after-target','drill.future','drill')"
sql "$pg" -c 'SELECT pg_switch_wal()' >/dev/null
br check
docker stop -t 15 "$pg" >/dev/null
started=$(date +%s)
docker run --rm --network none "${common[@]}" -v "$repo:/state/repo:ro" -v "$recovered:/state/db" \
  --entrypoint pgbackrest "$db_image" --config=/run/secrets/pgbackrest_conf --stanza=vpnshop \
  --type=time --target="$target" --target-action=promote --archive-mode=off restore
docker run -d --name "$restored" --network none "${common[@]}" -v "$repo:/state/repo:ro" -v "$recovered:/state/db" \
  --entrypoint postgres "$db_image" -c listen_addresses= >/dev/null
ready "$restored"
for i in {1..30}; do
  if [[ "$(sql "$restored" -c 'SELECT NOT pg_is_in_recovery()')" == t ]]; then break; fi
  sleep 1
done
[[ "$(sql "$restored" -c 'SELECT NOT pg_is_in_recovery()')" == t ]]
[[ "$(sql "$restored" -c "SELECT (SELECT count(*) FROM \"AuditLog\" WHERE id='pitr-before-target')=1
  AND NOT EXISTS (SELECT 1 FROM \"AuditLog\" WHERE id='pitr-after-target')")" == t ]]
sql "$restored" < ops/backup/control-totals.sql > "$tmp/after"
cmp "$tmp/before" "$tmp/after"
if [[ -e "$tmp/history.before" ]]; then
  sql "$restored" -c 'SELECT migration_name||'"'"':'"'"'||checksum FROM "_prisma_migrations" ORDER BY migration_name' > "$tmp/history.after"
  cmp "$tmp/history.before" "$tmp/history.after"
fi
docker exec -i -e MZT_ISOLATED_RESTORE=writers-stopped-isolated-target "$restored" \
  psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres < ops/backup/prepare-restored.sql >/dev/null
sql "$restored" < ops/backup/drill-replay.sql
sql "$restored" < ops/backup/control-totals.sql > "$tmp/replayed"
cmp "$tmp/before" "$tmp/replayed"
digest=$(sha256sum "$tmp/replayed" | cut -d' ' -f1)
printf 'PITR: %s UTC target, verified local drill runtime %ss, financial/control proof sha256:%s\n' "$target" "$(($(date +%s)-started))" "$digest"
