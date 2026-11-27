#!/usr/bin/env bash
set -Eeuo pipefail
trap 'if [[ "${GITHUB_ACTIONS:-}" == true ]]; then echo "::error::Compose smoke failed at line $LINENO"; fi' ERR
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
prefix=${MZT_TEST_IMAGE_PREFIX:-mzt-ci}
tmp=$(mktemp -d)
export COMPOSE_PROJECT_NAME="mzt-ops-${RANDOM}-${RANDOM}"
stack=(-f ops/compose.yml)
if [[ "${MZT_V2_MICRO:-0}" == 1 ]]; then
  export VPNSHOP_DB_CPUS=1 VPNSHOP_DB_MEMORY=512m
  export VPNSHOP_DB_SHARED_BUFFERS=64MB VPNSHOP_DB_WORK_MEM=2MB
  printf 'RESOURCE_PROFILE=micro\n' > "$tmp/resources.env"
fi
if [[ "${MZT_V2_SMOKE:-0}" == 1 ]]; then
  export COMPOSE_PROJECT_NAME="mzt-ci-single-${RANDOM}-${RANDOM}"
  stack=(--project-directory ops)
  for module in core admin edge mode.single mail backup.local; do stack+=(-f "ops/compose/$module.yml"); done
fi
dc() {
  if [[ "${GITHUB_ACTIONS:-}" == true && "$1" =~ ^(up|run|stop)$ ]]; then
    local output status
    output=$(mktemp)
    docker compose --env-file "$tmp/settings" --profile migration --profile monitoring "${stack[@]}" "$@" >"$output" 2>&1 || status=$?
    cat "$output"
    if [[ -n "${status:-}" ]]; then
      printf '::error::Compose %s: %s\n' "$*" "$(tail -12 "$output" | tr '\n%' '  ' | cut -c1-1100)"
    fi
    rm "$output"
    return "${status:-0}"
  fi
  docker compose --env-file "$tmp/settings" --profile migration --profile monitoring "${stack[@]}" "$@"
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
# The CA is public material used by the synthetic ACL probe.
chmod a+r "$tmp/ca.crt"
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
if [[ "${MZT_V2_SMOKE:-0}" == 1 ]]; then
  sed -i "s@^SECRETS_DIR=.*@SECRETS_DIR=$tmp/secrets@" "$tmp/settings"
  cat >> "$tmp/settings" <<SETTINGS
ADMIN_ACCESS_MODE=local
MZT_DEPLOY_ENV=staging
MZT_ENABLE_SMTP_EGRESS=1
MAIL_FROM=Smoke <fixture@example.invalid>
MZT_ENABLE_LOCAL_BACKUP=1
BACKUP_IMAGE=$prefix-backup:$revision
SETTINGS
  sed -n '/^[A-Z_]*_IMAGE=/p' "$tmp/settings" > "$tmp/release.env"
  sed -E '/^[A-Z_]*_IMAGE=|^SECRETS_DIR=/d' "$tmp/settings" > "$tmp/operator.env"
  mkdir -m 700 "$tmp/secrets"
  cp "$tmp/admin_cert" "$tmp/monitor_admin_cert"
  cp "$tmp/public_cert" "$tmp/monitor_public_cert"
  openssl rand -base64 32 > "$tmp/logical_key"
  while IFS='|' read -r name roles condition source format owner mode consumers; do
    [[ "$name" && "$name" != '#'* ]] || continue
    [[ -f "$tmp/$name" ]] || continue
    install -m "$mode" "$tmp/$name" "$tmp/secrets/$name"
  done < ops/templates/secrets.list
  python3 ops/scripts/preflight.py --role single --disposable --project-name "$COMPOSE_PROJECT_NAME" \
    --env-file "$tmp/operator.env" --release-env "$tmp/release.env" --secrets-dir "$tmp/secrets"
  while IFS='|' read -r name roles condition source format owner mode consumers; do
    [[ "$name" && "$name" != '#'* ]] || continue
    if [[ -f "$tmp/secrets/$name" ]]; then sudo -n chown "$owner" "$tmp/secrets/$name"; fi
  done < ops/templates/secrets.list
else
  # Legacy smoke fixtures only. Production and V2 require per-consumer ownership above.
  chmod a+r "$tmp"/db_* "$tmp"/*_url "$tmp"/*_key "$tmp"/*_cert "$tmp"/web_*
  dc config --format json | python3 ops/scripts/preflight.py --disposable
  if ADMIN_BIND_IP=0.0.0.0 dc config --format json | python3 ops/scripts/preflight.py --disposable >/dev/null 2>&1; then
    echo "Unsafe admin publish accepted" >&2; exit 1
  fi
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
for pair in 'public 18443 /login' 'admin 18444 /login'; do
  read -r zone port path <<<"$pair"
  headers=$(request "$zone" "$port" -fsS -D - -o /dev/null "https://$zone.mzt.test:$port$path" | tr -d '\r')
  grep -Eqi "^content-security-policy: .*script-src 'self';.*frame-ancestors 'none';" <<<"$headers"
  grep -Eqi '^referrer-policy: no-referrer$' <<<"$headers"
  grep -Eqi '^x-frame-options: DENY$' <<<"$headers"
  if grep -Eqi '^content-security-policy: .*unsafe-(inline|eval)' <<<"$headers"; then exit 1; fi
done
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
jq -nc --arg password "smoke-$(openssl rand -hex 18)" '{email:"synthetic@example.invalid",password:$password}' > "$tmp/customer.credentials"
request public 18443 -fsS -X POST -H 'Origin: https://public.mzt.test:18443' -H 'Content-Type: application/json' \
  --data-binary @"$tmp/customer.credentials" https://public.mzt.test:18443/api/auth/register | jq -e '.ok'
request public 18443 -fsS https://public.mzt.test:18443/api/plans | jq -e '.offers | length == 0'
dc exec -T db psql -U postgres -d vpnshop -Atc '
SELECT count(*)=1 FROM "NotificationOutbox" WHERE payload NOT LIKE '"'"'%synthetic@example.invalid%'"'"'
' | grep -qx t
if [[ "${MZT_V2_SMOKE:-0}" == 1 ]]; then
  dc run --rm --no-deps logical-local
  dc run --rm --no-deps --entrypoint sh logical-local -ec 'cd /state/proofs; set -- */SHA256SUMS; [ "$#" = 1 ]; cd "${1%/*}"; sha256sum -c SHA256SUMS'
  if [[ "${MZT_V2_CLI_SMOKE:-0}" == 1 ]]; then
    PYTHONDONTWRITEBYTECODE=1 python3 ops/scripts/v2_cli_pg_smoke.py "$tmp" \
      --env-file "$tmp/settings" --profile monitoring "${stack[@]}"
  fi
fi
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
dc exec -T exporter test ! -e /run/secrets/admin_tls_key
dc exec -T exporter node -e '
  fetch("http://172.30.75.12:9100/metrics").then(r=>r.text()).then(body=>{
    for (const origin of ["public", "admin"]) {
      const item=body.split("\n").find(line=>line.startsWith(`mzt_tls_certificate_seconds{origin="${origin}"} `));
      if (!item || Number(item.split(" ").at(-1)) <= 0) process.exit(1);
    }
  }).catch(()=>process.exit(1))'
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
if dc logs --no-color public-api admin-api public-edge admin-edge | grep -F "$marker" >/dev/null; then
  echo 'Sensitive synthetic marker in logs' >&2; exit 1
fi

# Schema failure is exercised only on this disposable database. Restore the exact fixture afterward.
dc exec -T db psql -U postgres -d vpnshop -v ON_ERROR_STOP=1 -c   "INSERT INTO \"_prisma_migrations\" (id,checksum,migration_name) VALUES ('ops-smoke-failed','fixture','ops_smoke_failed')" >/dev/null
wait_readiness public-api 3000 /api/ready 503
if dc run --rm --no-deps migrator >/dev/null 2>&1; then echo "Migration gate accepted a failed migration"; exit 1; fi
dc exec -T db psql -U postgres -d vpnshop -v ON_ERROR_STOP=1 -c   "DELETE FROM \"_prisma_migrations\" WHERE id = 'ops-smoke-failed'" >/dev/null
wait_readiness public-api 3000 /api/ready 200
if [[ "${MZT_V2_MICRO:-0}" == 1 ]]; then
  {
    echo '### Micro profile memory after deployment, synthetic activity and backup'
    echo 'Measured on the CI host with Micro container limits.'
    echo '```text'
    mapfile -t containers < <(dc ps -q)
    docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' "${containers[@]}"
    for container in "${containers[@]}"; do
      [[ "$(docker inspect --format '{{.State.OOMKilled}}' "$container")" == false ]]
      if peak=$(docker exec "$container" cat /sys/fs/cgroup/memory.peak 2>/dev/null) && [[ "$peak" =~ ^[0-9]+$ ]]; then
        printf '%s peak=%s bytes\n' "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")" "$peak"
      fi
    done
    echo '```'
  } | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
dc stop -t 25 worker public-api
for service in worker public-api; do
  [[ "$(docker inspect --format '{{.State.ExitCode}}' "$(dc ps -aq "$service")")" == 0 ]]
done
if [[ "${MZT_RELEASE_FAILURES:-0}" == 1 ]]; then
  dc up -d --wait --no-deps public-api worker
  # Retrieve the test email from its durable encrypted outbox without echoing plaintext.
  dc exec -T db psql -U postgres -d vpnshop -Atc 'SELECT payload FROM "NotificationOutbox" LIMIT 1' |
    dc exec -T notifications node -e '
      const { createDecipheriv, hkdfSync } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      const master = Buffer.from(readFileSync("/run/secrets/mail_key", "utf8").trim(), "base64");
      const key = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "vpn-shop:notification-outbox-v1", 32));
      const raw = Buffer.from(readFileSync(0, "utf8").trim(), "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0,12));
      decipher.setAuthTag(raw.subarray(12,28));
      const mail = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
      const token = new URLSearchParams(new URL(mail.text.match(/https?:\/\/\S+/)[0]).hash.slice(1)).get("token");
      if (!token || mail.to !== "synthetic@example.invalid") process.exit(1);
      process.stdout.write(JSON.stringify({token}));' > "$tmp/verify.json"
  origin='https://public.mzt.test:18443'
  [[ "$(request public 18443 -sS -w '%{http_code}' -o /dev/null -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data-binary @"$tmp/verify.json" "$origin/api/auth/verify-email")" == 204 ]]
  [[ "$(request public 18443 -sS -w '%{http_code}' -o /dev/null -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data-binary @"$tmp/verify.json" "$origin/api/auth/verify-email")" == 400 ]]
  request public 18443 -fsS -c "$tmp/customer.cookies" -D "$tmp/login.headers" -o /dev/null -H "Origin: $origin" -H 'Content-Type: application/json' \
    --data-binary @"$tmp/customer.credentials" "$origin/api/auth/login"
  tr -d '\r' < "$tmp/login.headers" | grep -Eqi '^set-cookie: vpn_at=.*; Secure;.*HttpOnly;.*SameSite=Lax|^set-cookie: vpn_at=.*; HttpOnly;.*Secure;.*SameSite=Lax'
  grep -Eqi '^cache-control: private, no-store' "$tmp/login.headers"
  dc exec -T db psql -U postgres -d vpnshop -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "Plan"(id,code,name,"deviceLimit") VALUES ('rel-plan','synthetic-release','Synthetic release',5);
INSERT INTO "PlanPrice"(id,"planId","durationMonths",currency,amount) VALUES ('rel-price','rel-plan',1,'RUB',15000);
INSERT INTO "OfferVersion"(id,"planPriceId",version,name,"durationMonths","deviceLimit",currency,amount,"publishedAt")
VALUES ('a9641a70-6f9b-48fa-9e8a-8bd4c4422f37','rel-price',1,'Synthetic release',1,5,'RUB',15000,now());
SQL
  offer=$(request public 18443 -fsS "$origin/api/plans" | jq -er '.offers[0].id')
  key=$(cat /proc/sys/kernel/random/uuid)
  order_request=$(jq -nc --arg offer "$offer" '{offerVersionId:$offer}')
  request public 18443 -fsS "$origin/api/config" | jq -e '.version == 1 and .availability.payments == false' >/dev/null
  [[ "$(request public 18443 -sS -w '%{http_code}' -o "$tmp/checkout.json" -b "$tmp/customer.cookies" -H "Origin: $origin" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $key" --data-binary "$order_request" "$origin/api/orders")" == 503 ]]
  jq -e '.error.code == "PAYMENTS_DISABLED"' "$tmp/checkout.json" >/dev/null
  dc exec -T db psql -U postgres -d vpnshop -Atc 'SELECT count(*)=0 AND NOT EXISTS (SELECT 1 FROM "Payment") FROM "Order"' | grep -qx t
  request public 18443 -fsS -b "$tmp/customer.cookies" -H "Origin: $origin" -X POST "$origin/api/auth/logout" >/dev/null
  [[ "$(request public 18443 -sS -w '%{http_code}' -o /dev/null -b "$tmp/customer.cookies" "$origin/api/orders")" == 401 ]]
  token=$(jq -er .token "$tmp/verify.json")
  if dc logs --no-color public-api admin-api public-edge admin-edge notifications | grep -F "$token" >/dev/null; then
    echo "Synthetic verification token appeared in logs"; exit 1
  fi
  rm -f "$tmp/verify.json" "$tmp/customer.cookies" "$tmp/login.headers" "$tmp/customer.credentials"
  dc stop -t 20 db
  wait_readiness public-api 3000 /api/health 200
  wait_readiness public-api 3000 /api/ready 503
  dc up -d --wait db
  wait_readiness public-api 3000 /api/ready 200
  dc kill --signal SIGKILL worker
  dc up -d --wait --no-deps worker
  wait_readiness worker 3002 /ready 200
  for attempt in {1..25}; do
    if dc exec -T db psql -U postgres -d vpnshop -Atc 'SELECT count(*)=1 FROM "NotificationOutbox" WHERE attempts>=1 AND "leaseId" IS NULL' | grep -qx t; then break; fi
    if [[ "$attempt" == 25 ]]; then echo "Unavailable SMTP did not leave a retryable outbox record"; exit 1; fi
    sleep 1
  done
  if [[ -n "${MZT_PRIOR_APPLICATION_IMAGE:-}" ]]; then
    before=$(dc exec -T db psql -U postgres -d vpnshop -At < ops/backup/control-totals.sql | sha256sum)
    dc stop -t 60 worker billing notifications public-api admin-api
    APPLICATION_IMAGE="$MZT_PRIOR_APPLICATION_IMAGE" dc up -d --wait --no-deps public-api admin-api
    old=$(docker image inspect --format '{{.Id}}' "$MZT_PRIOR_APPLICATION_IMAGE")
    for process in public-api admin-api; do
      [[ "$(docker inspect --format '{{.Image}}' "$(dc ps -q "$process")")" == "$old" ]]
    done
    for pair in 'public 18443' 'admin 18444'; do
      read -r zone port <<<"$pair"
      for attempt in {1..15}; do
        if request "$zone" "$port" -fsS -o /dev/null "https://$zone.mzt.test:$port/api/ready"; then break; fi
        if [[ "$attempt" == 15 ]]; then echo "Prior runtime TLS readiness failed"; exit 1; fi
        sleep 1
      done
    done
    [[ "$(dc exec -T db psql -U postgres -d vpnshop -At < ops/backup/control-totals.sql | sha256sum)" == "$before" ]]
    dc up -d --wait --no-deps public-api admin-api
    [[ "$(docker inspect --format '{{.Image}}' "$(dc ps -q public-api)")" != "$old" ]]
    printf 'Prior runtime compatibility (config digest %s); database controls unchanged: %s\n' "$old" "$before"
  fi
fi
if [[ "${MZT_V2_CLI_SMOKE:-0}" == 1 ]]; then
  # Synthetic credentials go only through stdin, never Docker argv or service logs.
  correlation=$(cat /proc/sys/kernel/random/uuid)
  local_admin=(docker compose --env-file "$tmp/settings" --profile monitoring "${stack[@]}"
    run -T --rm --no-deps admin-local)
  local_identity() {
    local operation=$1
    if ! "${local_admin[@]}" "$operation" 2>"$tmp/local-admin.stderr"; then
      local code
      code=$(grep -m1 -E '^(LOCAL_ADMIN_[A-Z0-9_]+|STAFF_[A-Z_]+|INVALID_LOCAL_INPUT|OWNER_[A-Z_]+)$' "$tmp/local-admin.stderr" || true)
      printf '::error::Isolated admin %s failed (%s)\n' "$operation" "${code:-container execution failed}" >&2
      return 1
    fi
  }
  jq -n --arg id "$correlation" '{username:"isolated-owner",password:("synthetic-"+$id),correlationId:$id}' |
    local_identity bootstrap |
    jq -e '.username == "isolated-owner" and .role == "OWNER"'
  local_identity list |
    jq -e 'any(.[]; .username == "isolated-owner" and .role == "OWNER")'
  dc stop -t 25 admin-api
  jq -n --arg id "$correlation" '{username:"isolated-owner",password:("different-"+$id),incident:"SMOKE-RECOVERY",
    correlationId:$id,resetTotp:true,restoreStatus:false}' |
    local_identity recover |
    jq -e '.username == "isolated-owner" and .active == true'
fi
echo "Compose, TLS, origins, schema failure, Prisma/Argon2, DB grants, secret scopes and SIGTERM verified"
