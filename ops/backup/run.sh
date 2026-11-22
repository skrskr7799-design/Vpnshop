#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${MZT_DEPLOY_DIR:?Set protected deployment directory}"
: "${COMPOSE_PROJECT_NAME:?Set fixed stack project name}"
exec 9>"$MZT_DEPLOY_DIR/backup.lock"
flock -w 1800 9
dc() { docker compose --env-file "$MZT_DEPLOY_DIR/active.settings" -f ops/compose.yml -f ops/compose.backup.yml --profile backup "$@"; }
br() { dc exec -T db pgbackrest --config=/run/secrets/pgbackrest_conf --stanza=vpnshop "$@"; }
case "${1:-}" in
  init)
    br stanza-create
    br check
    ;;
  physical)
    kind=diff
    if [[ "$(date -u +%u)" == 7 ]]; then kind=full; fi
    if ! br --output=json info | jq -e '.[0].backup | length > 0' >/dev/null; then kind=full; fi
    br --type="$kind" backup
    br check
    br verify
    dc exec -T db sh -ec 'date -u +%s >/state/proofs/.physical_epoch; mv /state/proofs/.physical_epoch /state/proofs/physical_epoch'
    ;;
  logical) dc run --rm --no-deps logical ;;
  record-restore)
    # This command records signed-off off-site evidence. The CI fixture never updates it.
    report=${2:?Provide the reviewed off-site restore report}
    now=$(date -u +%s)
    completed=$(jq -er --argjson now "$now" '
      select(.verified == true and .storage == "off-site" and (.controlSha256 | test("^[a-f0-9]{64}$"))) |
      .completedAt | fromdateiso8601 | select(. <= $now and . >= $now - 2678400)
    ' "$report")
    printf '%s\n' "$completed" | dc exec -T db sh -ec 'cat > /state/proofs/.restore_epoch; mv /state/proofs/.restore_epoch /state/proofs/restore_epoch'
    ;;
  *) exit 64 ;;
esac
