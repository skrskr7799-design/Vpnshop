#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
output=${1:?Set candidate output directory}
previous=${2:?Set the actual prior runtime digest}
[[ "$previous" =~ ^sha256:[a-f0-9]{64}$ ]]
mkdir -p "$output"
output=$(realpath "$output")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
targets=()
for image in application migrator web admin edge db backup; do targets+=("mzt-ci-$image:$revision"); done
docker image save -o "$tmp/images.tar" "${targets[@]}"
python3 ops/scripts/release-manifest.py "$tmp/images.tar" "$revision" "$output/candidate.json" "$previous"
zstd --quiet -T2 -6 "$tmp/images.tar" -o "$output/images.tar.zst"
(cd "$output" && sha256sum candidate.json images.tar.zst > SHA256SUMS && sha256sum -c SHA256SUMS)
manifest=$(sha256sum "$output/candidate.json" | cut -d' ' -f1)
printf 'Candidate manifest SHA-256: %s\n' "$manifest"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Candidate manifest SHA-256: %s\n' "$manifest" >> "$GITHUB_STEP_SUMMARY"
  printf '::notice title=Candidate manifest::sha256:%s\n' "$manifest"
fi
