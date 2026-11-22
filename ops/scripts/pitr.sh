#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
db_image=${MZT_DRILL_DB_IMAGE:-mzt-ci-db:$revision}
migrator=${MZT_DRILL_MIGRATOR_IMAGE:-mzt-ci-migrator:$revision}
storage=${MZT_DRILL_REPO:-local}
[[ "$storage" == local || "$storage" == s3 ]]
tmp=$(mktemp -d)
scope="mzt-pitr-${tmp##*.}"
pg="$scope-primary"
object_store="$scope-s3"
tls_proxy="$scope-tls"
restored="$scope-restored"
network="$scope-closed"
repo="$scope-repo"
proofs="$scope-proofs"
state="$scope-primary-data"
recovered="$scope-restored-data"
cleanup() {
  docker rm -f "$pg" "$restored" "$object_store" "$tls_proxy" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$repo" "$state" "$recovered" "$proofs" >/dev/null 2>&1 || true
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
subnet=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$network")
mount_repo=(-v "$repo:/state/repo")
restore_repo=(-v "$repo:/state/repo:ro")
restore_network=none
backup_image=${MZT_DRILL_BACKUP_IMAGE:-mzt-ci-backup:$revision}
ca_mount=()
if [[ "$storage" == s3 ]]; then
  docker run -d --name "$object_store" --network "$network" --network-alias fixture-store \
    -e SERVICES=s3 -e GATEWAY_LISTEN=0.0.0.0:4566 -e DISABLE_EVENTS=1 -e DNS_ADDRESS=0 \
    -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_DEFAULT_REGION=us-east-1 \
    -e AWS_EC2_METADATA_DISABLED=true -e NO_PROXY=127.0.0.1,localhost \
    'localstack/localstack:4.5.0@sha256:9d4253786e0effe974d77fe3c390358391a56090a4fff83b4600d8a64404d95d' >/dev/null
  for i in {1..60}; do
    if docker exec "$object_store" awslocal --endpoint-url http://127.0.0.1:4566 s3api create-bucket --bucket replay-fixture >/dev/null 2>&1; then break; fi
    if [[ "$i" == 60 ]]; then docker logs --tail 15 "$object_store"; exit 1; fi
    sleep 1
  done
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=isolated-drill-s3 -addext 'subjectAltName=DNS:pitr-s3' \
    -keyout "$tmp/s3.key" -out "$tmp/s3.crt" 2>/dev/null
  cat > "$tmp/s3.conf" <<'NGINX'
pid /tmp/nginx.pid;
error_log stderr;
events {}
http {
  access_log off;
  client_body_temp_path /tmp/body;
  proxy_temp_path /tmp/proxy;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server {
    listen 9443 ssl;
    ssl_certificate /test/tls.crt;
    ssl_certificate_key /test/tls.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 0;
    location / {
      proxy_set_header Host $http_host;
      proxy_http_version 1.1;
      proxy_pass http://fixture-store:4566;
    }
  }
}
NGINX
  chmod a+r "$tmp/s3.key" "$tmp/s3.crt" "$tmp/s3.conf"
  docker run -d --name "$tls_proxy" --network "$network" --network-alias pitr-s3 --read-only --user 101:101 \
    --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:mode=1777 \
    -v "$tmp/s3.key:/test/tls.key:ro" -v "$tmp/s3.crt:/test/tls.crt:ro" -v "$tmp/s3.conf:/test/nginx.conf:ro" \
    --entrypoint nginx 'nginx:1.30-alpine@sha256:caf4e1e032a20f9c3c5e28fc7f25ffd768ad8677b4975c54193075997b3a97e3' \
    -c /test/nginx.conf -g 'daemon off;' >/dev/null
  sed -i 's@repo1-path=/state/repo@repo1-path=/drill@' "$tmp/pgbackrest_conf"
  cat >> "$tmp/pgbackrest_conf" <<'S3'
repo1-type=s3
repo1-s3-bucket=replay-fixture
repo1-s3-endpoint=pitr-s3
repo1-s3-region=us-east-1
repo1-s3-key=test
repo1-s3-key-secret=test
repo1-s3-uri-style=path
repo1-storage-port=9443
repo1-storage-ca-file=/run/secrets/s3_ca
repo1-storage-verify-tls=y
S3
  mount_repo=()
  restore_repo=()
  restore_network=$network
  ca_mount=(-v "$tmp/s3.crt:/run/secrets/s3_ca:ro")
fi
for name in "$repo" "$state" "$recovered"; do
  ! docker volume inspect "$name" >/dev/null 2>&1
  docker volume create "$name" >/dev/null
done
common=(--user 999:999 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:mode=1777
  --tmpfs /var/run/postgresql:mode=1777 -v "$tmp/pgbackrest_conf:/run/secrets/pgbackrest_conf:ro" "${ca_mount[@]}")
archive='pgbackrest --config=/run/secrets/pgbackrest_conf --stanza=vpnshop archive-push %p'
docker run -d --name "$pg" --network "$network" --network-alias pitr-db "${common[@]}" \
  "${mount_repo[@]}" -v "$state:/state/db" -v "$tmp/pgpass:/run/secrets/drill_pgpass:ro" \
  --entrypoint sh "$db_image" -ec 'initdb --auth-local=trust --auth-host=scram-sha-256 --username=postgres --pwfile=/run/secrets/drill_pgpass --data-checksums >/dev/null
    printf "host postgres all %s scram-sha-256\n" "$2" >> "$PGDATA/pg_hba.conf"
    exec postgres -c listen_addresses="*" -c archive_mode=on -c archive_timeout=30 -c "archive_command=$1"' sh "$archive" "$subnet" >/dev/null
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
if [[ "$storage" == s3 && "${MZT_DRILL_LOGICAL:-1}" == 1 ]]; then
  docker volume create "$proofs" >/dev/null
  openssl rand -hex 24 > "$tmp/backup_password"
  printf 'postgresql://drill_backup:%s@pitr-db:5432/postgres\n' "$(cat "$tmp/backup_password")" > "$tmp/backup_url"
  openssl rand -hex 32 > "$tmp/logical_key"
  printf '[default]\naws_access_key_id=test\naws_secret_access_key=test\n' > "$tmp/logical_credentials"
  chmod a+r "$tmp/backup_url" "$tmp/logical_key" "$tmp/logical_credentials"
  docker exec -i -e DRILL_BACKUP_PASSWORD="$(cat "$tmp/backup_password")" "$pg" \
    psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
\getenv password DRILL_BACKUP_PASSWORD
SELECT format('CREATE ROLE drill_backup LOGIN PASSWORD %L', :'password') \gexec
GRANT USAGE ON SCHEMA public TO drill_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drill_backup;
SQL
  docker run --rm --network "$network" --read-only --tmpfs /tmp:mode=1777 --cap-drop ALL --security-opt no-new-privileges \
    --user 999:999 -e AWS_CA_BUNDLE=/run/secrets/s3_ca -e HTTP_PROXY= -e HTTPS_PROXY= -e http_proxy= -e https_proxy= \
    -e S3_ENDPOINT=https://pitr-s3:9443 -e S3_BUCKET=replay-fixture -e KEY_VERSION=drill-v1 -e AWS_DEFAULT_REGION=us-east-1 \
    -v "$tmp/s3.crt:/run/secrets/s3_ca:ro" -v "$tmp/backup_url:/run/secrets/backup_url:ro" \
    -v "$tmp/logical_key:/run/secrets/logical_key:ro" -v "$tmp/logical_credentials:/run/secrets/logical_s3_credentials:ro" \
    -v "$proofs:/state/proofs" "$backup_image"
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 999:999 \
    -v "$proofs:/state/proofs:ro" --entrypoint test "$backup_image" -s /state/proofs/logical_epoch
fi
br stanza-create
br check
br --type=full backup
if [[ "${MZT_RELEASE_FAILURES:-0}" == 1 ]]; then
  br --type=diff backup
  br --output=json info | jq -e '.[0].backup | map(.type) | (index("full") != null and index("diff") != null)' >/dev/null
fi
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
docker run --rm --network "$restore_network" "${common[@]}" "${restore_repo[@]}" -v "$recovered:/state/db" \
  --entrypoint pgbackrest "$db_image" --config=/run/secrets/pgbackrest_conf --stanza=vpnshop \
  --type=time --target="$target" --target-action=promote --archive-mode=off restore
docker run -d --name "$restored" --network "$restore_network" "${common[@]}" "${restore_repo[@]}" -v "$recovered:/state/db" \
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
evidence=$(printf 'PITR (%s): %s UTC target, verified drill runtime %ss, financial/control proof sha256:%s' "$storage" "$target" "$(($(date +%s)-started))" "$digest")
printf '%s\n' "$evidence"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then printf '%s\n' "$evidence" >> "$GITHUB_STEP_SUMMARY"; fi
