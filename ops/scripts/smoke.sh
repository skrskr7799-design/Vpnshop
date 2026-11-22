#!/usr/bin/env bash
set -Eeuo pipefail
trap 'if [[ "${GITHUB_ACTIONS:-}" == true ]]; then echo "::error::Compose smoke failed at line $LINENO"; fi' ERR
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
prefix=${MZT_TEST_IMAGE_PREFIX:-mzt-ci}
tmp=$(mktemp -d)
export COMPOSE_PROJECT_NAME="mzt-ops-${RANDOM}-${RANDOM}"
dc() {
  if [[ "${GITHUB_ACTIONS:-}" == true && "$1" =~ ^(up|run|stop)$ ]]; then
    local output status
    output=$(mktemp)
    docker compose --env-file "$tmp/settings" --profile migration --profile monitoring -f ops/compose.yml "$@" >"$output" 2>&1 || status=$?
    cat "$output"
    if [[ -n "${status:-}" ]]; then
      printf '::error::Compose %s: %s\n' "$*" "$(tail -12 "$output" | tr '\n%' '  ' | cut -c1-1100)"
    fi
    rm "$output"
    return "${status:-0}"
  fi
  docker compose --env-file "$tmp/settings" --profile migration --profile monitoring -f ops/compose.yml "$@"
}
cleanup() {
  if [[ -e "$tmp/settings" ]]; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
umask 077
for role in superuser migrator public admin worker billing notifications backup monitor; do
  openssl rand -hex 32 > "$tmp/db_$role"
done
for item in 'migrator migrate' 'public public' 'admin admin' 'worker worker' 'billing billing' 'notifications notifications' 'backup backup' 'monitor monitor'; do
  read -r role host <<<"$item"
  suffix=
  if [[ "$role" != migrator && "$role" != backup ]]; then suffix='?connection_limit=3&connect_timeout=2&socket_timeout=5'; fi
  printf 'postgresql://mzt_%s:%s@pg-%s:5432/vpnshop%s\n' "$role" "$(cat "$tmp/db_$role")" "$host" "$suffix" > "$tmp/${role}_url"
done
for key in web_jwt web_cookie mail_key admin_key; do openssl rand -base64 32 > "$tmp/$key"; done
printf 'smtps://mail.invalid:465\n' > "$tmp/smtp_url"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=MZT-Smoke-CA -keyout "$tmp/ca.key" -out "$tmp/ca.crt" 2>/dev/null
for zone in public admin; do
  key="$tmp/${zone}_key"
  [[ "$zone" != admin ]] || key="$tmp/admin_tls_key"
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$zone.mzt.test" -keyout "$key" -out "$tmp/$zone.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s.mzt.test\nextendedKeyUsage=serverAuth\n' "$zone" > "$tmp/$zone.ext"
  openssl x509 -req -in "$tmp/$zone.csr" -CA "$tmp/ca.crt" -CAkey "$tmp/ca.key" -CAcreateserial -days 1     -extfile "$tmp/$zone.ext" -out "$tmp/${zone}_cert" 2>/dev/null
done
rm "$tmp/ca.key"
# Test-only permissions. The parent directory remains private to the runner.
chmod a+r "$tmp"/db_* "$tmp"/*_url "$tmp"/*_key "$tmp"/*_cert "$tmp"/web_* "$tmp/ca.crt"
cat > "$tmp/settings" <<SETTINGS
APPLICATION_IMAGE=$prefix-application:$revision
MIGRATOR_IMAGE=$prefix-migrator:$revision
DATABASE_IMAGE=$prefix-db:$revision
WEB_IMAGE=$prefix-web:$revision
ADMIN_IMAGE=$prefix-admin:$revision
EDGE_IMAGE=$prefix-edge:$revision
SECRETS_DIR=$tmp
PUBLIC_HOST=public.mzt.test
PUBLIC_ORIGIN=https://public.mzt.test:18443
PUBLIC_BIND_IP=127.0.0.1
PUBLIC_TLS_PORT=18443
ADMIN_HOSTNAME=admin.mzt.test
ADMIN_ORIGIN=https://admin.mzt.test:18444
ADMIN_BIND_IP=127.0.0.1
ADMIN_TLS_PORT=18444
ADMIN_CLIENT_CIDRS=127.0.0.1/32,172.30.74.1/32
SETTINGS
dc config --format json | python3 ops/scripts/preflight.py --disposable
if ADMIN_BIND_IP=0.0.0.0 dc config --format json | python3 ops/scripts/preflight.py --disposable >/dev/null 2>&1; then
  echo "Unsafe admin publish accepted" >&2; exit 1
fi
dc up -d --wait db
dc up -d --no-deps public-api
wait_readiness() {
  local service=$1 port=$2 route=$3 status=$4
  for i in {1..40}; do
    if dc exec -T "$service" node -e 'fetch(process.argv[1]).then(r=>process.exit(r.status===Number(process.argv[2])?0:1)).catch(()=>process.exit(1))'       "http://127.0.0.1:$port$route" "$status"; then return 0; fi
    sleep 1
  done
  local logs
  logs=$(dc logs --tail 15 --no-color "$service" 2>&1)
  printf '%s\n' "$logs"
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    detail=$(printf '%s\n' "$logs" | grep -E 'Error|reasonCode|Invalid|Configuration|Module' | tail -6 | tr '\n%' '  ' | cut -c1-550 || true)
    printf '::error::%s failed readiness %s %s: %s\n' "$service" "$route" "$status" "$detail"
  fi
  return 1
}
wait_readiness public-api 3000 /api/health 200
wait_readiness public-api 3000 /api/ready 503
dc run --rm --no-deps migrator
dc run --rm --no-deps migrator
dc up -d --wait --wait-timeout 100 public-api admin-api web admin public-edge admin-edge worker billing notifications exporter prometheus alertmanager alert-sink
request() {
  local zone=$1 port=$2
  shift 2
  curl --noproxy '*' --max-time 5 --cacert "$tmp/ca.crt" --resolve "$zone.mzt.test:$port:127.0.0.1" "${@}"
}
[[ "$(request public 18443 -sS -o /dev/null -w '%{http_code}' https://public.mzt.test:18443/api/ready)" == 200 ]]
[[ "$(request admin 18444 -sS -o /dev/null -w '%{http_code}' https://admin.mzt.test:18444/api/ready)" == 200 ]]
request public 18443 -fsS https://public.mzt.test:18443/account | grep -q '<div id="root">'
request admin 18444 -fsS https://admin.mzt.test:18444/users | grep -q '<div id="root">'
[[ "$(request public 18443 -sS -o /dev/null -w '%{http_code}' https://public.mzt.test:18443/api/staff)" == 404 ]]
[[ "$(request public 18443 -sS -o /dev/null -w '%{http_code}' https://public.mzt.test:18443/api/metrics)" == 404 ]]
[[ "$(request admin 18444 -sS -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: 203.0.113.99,::1' https://admin.mzt.test:18444/api/me)" == 401 ]]
if request admin 18443 -fsS https://admin.mzt.test:18443/api/ready >/dev/null 2>&1; then
  echo "Admin SNI accepted on public edge" >&2; exit 1
fi
docker run --rm --network "${COMPOSE_PROJECT_NAME}_admin-ingress" --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$tmp/ca.crt:/test/ca.crt:ro" -e NODE_EXTRA_CA_CERTS=/test/ca.crt \
  --entrypoint node "$prefix-application:$revision" -e '
    const https = require("node:https");
    https.get({ hostname: "admin-edge", servername: "admin.mzt.test", port: 8443, path: "/api/me",
      headers: { Host: "admin.mzt.test", "X-Forwarded-For": "127.0.0.1" } },
      r => { r.resume(); if (r.statusCode !== 403) { console.error("Expected isolated ACL rejection, received", r.statusCode); process.exit(1); } })
      .on("error", e => { console.error("Isolated ACL TLS request failed", e.code); process.exit(1); });'
request public 18443 -fsS -X POST -H 'Origin: https://public.mzt.test:18443' -H 'Content-Type: application/json' \
  --data '{"email":"synthetic@example.invalid","password":"synthetic-test-strong-12"}' https://public.mzt.test:18443/api/auth/register | jq -e '.ok'
request public 18443 -fsS https://public.mzt.test:18443/api/plans | jq -e '.offers | length == 0'
dc exec -T db psql -U postgres -d vpnshop -Atc '
SELECT count(*)=1 FROM "NotificationOutbox" WHERE payload NOT LIKE '"'"'%synthetic@example.invalid%'"'"'
' | grep -qx t
dc exec -T db psql -U postgres -d vpnshop -Atc '
SELECT NOT has_schema_privilege('"'"'mzt_public'"'"','"'"'public'"'"','"'"'CREATE'"'"')
AND NOT has_table_privilege('"'"'mzt_public'"'"','"'"'"StaffCredential"'"'"','"'"'SELECT'"'"')
AND NOT has_table_privilege('"'"'mzt_admin'"'"','"'"'"PaymentTransaction"'"'"','"'"'INSERT'"'"')
AND NOT has_table_privilege('"'"'mzt_admin'"'"','"'"'"AuditLog"'"'"','"'"'UPDATE'"'"')
AND NOT has_table_privilege('"'"'mzt_worker'"'"','"'"'"User"'"'"','"'"'UPDATE'"'"')
AND NOT has_table_privilege('"'"'mzt_billing'"'"','"'"'"PaymentTransaction"'"'"','"'"'INSERT'"'"')
' | grep -qx t
for service in db public-api admin-api worker billing notifications web admin public-edge admin-edge exporter prometheus alertmanager alert-sink; do
  [[ "$(dc exec -T "$service" id -u)" != 0 ]]
  if [[ "$service" != *-edge ]]; then [[ -z "$(docker port "$(dc ps -q "$service")")" ]]; fi
done
dc exec -T public-api test ! -e /run/secrets/admin_key
dc exec -T admin-api test ! -e /run/secrets/web_jwt
dc exec -T worker test ! -e /run/secrets/smtp_url
dc exec -T public-api node -e 'fetch("http://172.30.77.11:3001/ready",{signal:AbortSignal.timeout(1200)}).then(()=>process.exit(1)).catch(()=>{})'
dc exec -T admin-api node -e 'fetch("http://172.30.76.10:3000/api/ready",{signal:AbortSignal.timeout(1200)}).then(()=>process.exit(1)).catch(()=>{})'

# Exporter isolation, rule syntax, alert delivery and secret-free log records.
dc exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
dc exec -T alertmanager amtool check-config /etc/alertmanager/alertmanager.yml
dc exec -T exporter node -e 'fetch("http://172.30.75.12:9100/metrics").then(async r=>process.exit((await r.text()).includes("mzt_postgres_up 1")?0:1)).catch(()=>process.exit(1))'
dc exec -T alert-sink node -e '
  fetch("http://alertmanager:9093/api/v2/alerts",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify([{labels:{alertname:"SyntheticSmoke",severity:"critical",group:"smoke"}}])})
    .then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
for i in {1..20}; do
  if dc exec -T alert-sink node -e 'fetch("http://127.0.0.1:9180/health").then(r=>r.json()).then(x=>process.exit(x.sent>0?0:1)).catch(()=>process.exit(1))'; then break; fi
  if [[ "$i" == 20 ]]; then echo 'No isolated Alertmanager delivery'; exit 1; fi
  sleep 1
done
marker=MZT-ISO-SYNTHETIC-SECRET
request public 18443 -sS -o /dev/null -H "Authorization: Bearer $marker" -H "Cookie: test=$marker" \
  "https://public.mzt.test:18443/api/auth/oauth/google/callback?code=$marker"
if dc logs --no-color public-api admin-api public-edge admin-edge | grep -F "$marker"; then
  echo 'Sensitive synthetic marker in logs' >&2; exit 1
fi

# Schema failure is exercised only on this disposable database. Restore the exact fixture afterward.
dc exec -T db psql -U postgres -d vpnshop -v ON_ERROR_STOP=1 -c   "INSERT INTO \"_prisma_migrations\" (id,checksum,migration_name) VALUES ('ops-smoke-failed','fixture','ops_smoke_failed')" >/dev/null
wait_readiness public-api 3000 /api/ready 503
if dc run --rm --no-deps migrator >/dev/null 2>&1; then echo "Migration gate accepted a failed migration"; exit 1; fi
dc exec -T db psql -U postgres -d vpnshop -v ON_ERROR_STOP=1 -c   "DELETE FROM \"_prisma_migrations\" WHERE id = 'ops-smoke-failed'" >/dev/null
wait_readiness public-api 3000 /api/ready 200
dc stop -t 25 worker public-api
for service in worker public-api; do
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$(dc ps -aq "$service")")" == 0 ]]
done
echo "Compose, TLS, origins, schema failure, Prisma/Argon2, DB grants, secret scopes and SIGTERM verified"
