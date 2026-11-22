#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
prefix=${1:-mzt-ci}
build_args=()
if [[ -n "${MZT_BUILD_CA_FILE:-}" ]]; then build_args+=(--secret "id=proxy_ca,src=$MZT_BUILD_CA_FILE"); fi
for target in application migrator web admin edge; do
  docker build "${build_args[@]}" --target "$target" --build-arg "REVISION=$revision" -t "$prefix-$target:$revision" .
done
docker build -f ops/db/Dockerfile --build-arg "REVISION=$revision" -t "$prefix-db:$revision" .
