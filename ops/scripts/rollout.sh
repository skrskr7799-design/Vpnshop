#!/usr/bin/env bash
# Operates only when invoked explicitly by an authorized host operator.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${MZT_DEPLOY_DIR:?Use a protected deployment directory}"
: "${COMPOSE_PROJECT_NAME:?Set the fixed stack project name}"
action=${1:?Use stage or rollback}
candidate=${2:?Provide a reviewed manifest path}
previous=${3:-}
[[ "$action" == stage || "$action" == rollback ]]
exec 9>"$MZT_DEPLOY_DIR/release.lock"
flock -n 9
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
jq -e '.version == 1 and (.gitSha | test("^[0-9a-f]{40}$")) and (.schema | test("^[0-9]{14}_[a-z0-9_]+$")) and
  (.images | [.application,.migrator,.db,.web,.admin,.edge] | all(test("^ghcr\\.io/skrskr7799-design/vpnshop/[a-z]+@sha256:[a-f0-9]{64}$")))' \
  "$candidate" >/dev/null
if [[ "$action" == stage && "$(jq -r .previousManifest "$candidate")" != first-release ]]; then
  [[ -n "$previous" && "sha256:$(sha256sum "$previous" | cut -d' ' -f1)" == "$(jq -r .previousManifest "$candidate")" ]]
fi
if [[ "$action" == rollback ]]; then
  # An older schema floor alone does not certify a rollback.
  [[ -n "$previous" && -f "$MZT_DEPLOY_DIR/schema-rollback-approved" ]]
  [[ "$(cat "$MZT_DEPLOY_DIR/schema-rollback-approved")" == "$(sha256sum "$candidate" | cut -d' ' -f1)" ]]
  [[ "sha256:$(sha256sum "$candidate" | cut -d' ' -f1)" == "$(jq -r .previousManifest "$previous")" ]]
fi
grep -Ev '^[[:upper:]_]+_IMAGE=' "$MZT_DEPLOY_DIR/settings" > "$tmp/settings"
for pair in 'APPLICATION application' 'MIGRATOR migrator' 'DATABASE db' 'WEB web' 'ADMIN admin' 'EDGE edge' 'MONITOR monitor' 'ALERT alert' 'UTILITY utility' 'BACKUP backup'; do
  read -r key image <<<"$pair"
  ref=$(jq -er ".images.$image // empty" "$candidate") || continue
  printf '%s_IMAGE=%s\n' "$key" "$ref" >> "$tmp/settings"
  docker pull "$ref" >/dev/null
  label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")
  [[ "$label" == "$(jq -r .gitSha "$candidate")" ]]
done
stack=(-f ops/compose.yml)
if [[ "${MZT_ENABLE_OFFSITE:-0}" == 1 ]]; then stack+=(-f ops/compose.backup.yml); fi
dc() { docker compose --env-file "$tmp/settings" --profile migration --profile monitoring "${stack[@]}" "$@"; }
dc config --format json | python3 ops/scripts/preflight.py
dc up -d --wait db
dc stop -t 60 worker billing notifications public-api admin-api
if [[ "$action" == stage ]]; then dc run --rm --no-deps migrator; fi
dc up -d --wait --wait-timeout 100 web admin public-api admin-api public-edge admin-edge
for zone in public admin; do
  url=$(dc config --format json | jq -er --arg zone "$zone" '.services[$zone+"-api"].environment[(if $zone=="public" then "WEB_ORIGIN" else "ADMIN_ORIGIN" end)]')
  curl --max-time 8 -fsS "$url/api/ready" >/dev/null
done
# Task activation is a separate operator action after readiness and compatibility evidence.
dc up -d exporter prometheus alertmanager alert-sink
cp "$tmp/settings" "$MZT_DEPLOY_DIR/active.settings"
cp "$candidate" "$MZT_DEPLOY_DIR/live-manifest.json"
printf '%s\n' "Both TLS origins are ready. Workers remain stopped until operator activation."
