#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
prefix=${1:-mzt-ci}
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
for target in application migrator web admin edge; do
  build "${build_args[@]}" --target "$target" --build-arg "REVISION=$revision" -t "$prefix-$target:$revision" .
done
for target in database backup; do
  name=$target
  if [[ "$target" == database ]]; then name=db; fi
  build "${build_args[@]}" -f ops/db/Dockerfile --target "$target" --build-arg "REVISION=$revision" -t "$prefix-$name:$revision" .
done
