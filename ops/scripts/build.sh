#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
prefix=${1:-mzt-ci}
if (( $# )); then shift; fi
if (( $# == 0 )); then set -- application migrator web admin edge db backup; fi
build() {
  local output
  output=$(mktemp)
  if BUILDKIT_PROGRESS=plain docker build "$@" >"$output" 2>&1; then
    tail -6 "$output"
    rm "$output"
    return
  fi
  tail -60 "$output"
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    detail=$(sed -n -E '/ERROR:|Error:|ERR_PNPM_|Error code|not found/s/^#?[0-9]* *[0-9.]* *//p' "$output" | tail -7 | tr '\n%' '  ' | cut -c1-600)
    printf '::error::Docker build failed %s\n' "$detail"
  fi
  rm "$output"
  return 1
}
build_args=()
if [[ -n "${MZT_BUILD_CA_FILE:-}" ]]; then build_args+=(--secret "id=proxy_ca,src=$MZT_BUILD_CA_FILE"); fi
if [[ -n "${MZT_BUILD_PLATFORM:-}" ]]; then build_args+=(--platform "$MZT_BUILD_PLATFORM"); fi
for name in "$@"; do
  target=$name
  case "$name" in
    application|migrator|web|admin|edge) dockerfile=Dockerfile ;;
    db) dockerfile=ops/db/Dockerfile; target=database ;;
    backup) dockerfile=ops/db/Dockerfile ;;
    *) printf 'Unknown image target\n' >&2; exit 64 ;;
  esac
  build "${build_args[@]}" -f "$dockerfile" --target "$target" --build-arg "REVISION=$revision" -t "$prefix-$name:$revision" .
done
