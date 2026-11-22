#!/usr/bin/env bash
set -euo pipefail
revision=$(git rev-parse HEAD)
[[ "$revision" == "${GITHUB_SHA:?}" ]]
[[ "${GITHUB_REF:?}" == refs/heads/main ]]
[[ "$PREVIOUS_MANIFEST" == first-release || "$PREVIOUS_MANIFEST" =~ ^sha256:[a-f0-9]{64}$ ]]
registry="ghcr.io/${GITHUB_REPOSITORY,,}"
root=$(mktemp -d)
export DOCKER_CONFIG=$root
trap 'rm -rf "$root"' EXIT
printf '%s' "${GHCR_TOKEN:?}" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin >/dev/null
unset GHCR_TOKEN
images='{}'
for target in application migrator web admin edge db; do
  localImage="mzt-ci-$target:$revision"
  ref="$registry/$target:$revision"
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$localImage")" == "$revision" ]]
  docker tag "$localImage" "$ref"
  docker push "$ref"
  digest=$(docker buildx imagetools inspect "$ref" | awk '/^Digest:/ {print $2; exit}')
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
  pinned="$registry/$target@$digest"
  docker pull "$pinned" >/dev/null
  [[ "$(docker image inspect --format '{{.Id}}' "$pinned")" == "$(docker image inspect --format '{{.Id}}' "$localImage")" ]]
  images=$(jq -cn --argjson images "$images" --arg key "$target" --arg value "$pinned" '$images + {($key): $value}')
done
schema=$(find apps/api/prisma/migrations -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | tail -1)
checksum=$(find apps/api/prisma/migrations -name migration.sql -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
jq -n --arg sha "$revision" --argjson images "$images" --arg schema "$schema" --arg schemaChecksum "sha256:$checksum" \
  --arg previous "$PREVIOUS_MANIFEST" '{version:1, gitSha:$sha, images:$images, schema:$schema,
    migrationTree:$schemaChecksum, previousManifest:$previous, stage:"candidate"}' > release-manifest.json
