#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
output=${1:?Set the report directory}
mkdir -p "$output"
output=$(realpath "$output")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gitleaks=zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9
trivy=aquasec/trivy:0.69.3@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c

# A current deny can block the candidate but remains distinct from a finding.
decision=0
git_result=0
docker run --rm --network none -u "$(id -u):$(id -g)" -v "$PWD:/repo:ro" -v "$tmp:/scan" "$gitleaks" \
  git --redact=100 --no-banner --gitleaks-ignore-path /repo/.gitleaksignore --log-opts=HEAD --report-format json --report-path /scan/history.json /repo || git_result=$?
if [[ "$git_result" != 0 ]]; then decision=1; fi
audit_result=0
pnpm audit --json --prod --audit-level high > "$output/npm-production.json" || audit_result=$?
if [[ "$audit_result" != 0 ]]; then decision=1; fi
audit_all_result=0
pnpm audit --json --audit-level high > "$output/npm-all.json" || audit_all_result=$?
if ! jq -e '.metadata.vulnerabilities != null' "$output/npm-production.json" "$output/npm-all.json" >/dev/null; then decision=1; fi

mkdir "$tmp/cache"
scan_image() {
  docker run --rm -u "$(id -u):$(id -g)" -v "$tmp:/scan" "$trivy" image --cache-dir /scan/cache \
    --db-repository ghcr.io/aquasecurity/trivy-db:2 \
    --java-db-repository ghcr.io/aquasecurity/trivy-java-db:1 --disable-telemetry --timeout 5m "$@"
}
critical=0
secret_count=0
scan_failed=0
findings='{}'
for image in application migrator web admin edge db backup prometheus alertmanager; do
  ref="mzt-ci-$image:$revision"
  if [[ "$image" == prometheus || "$image" == alertmanager ]]; then
    ref=$(awk -v name="$image" '$1 == "image:" && $2 ~ "^prom/" name ":.*@sha256:" {print $2}' ops/compose.yml)
    [[ "$ref" =~ @sha256:[a-f0-9]{64}$ ]]
    if ! docker image inspect "$ref" >/dev/null 2>&1; then docker pull "$ref"; fi
  fi
  printf 'Scanning release image %s\n' "$image"
  docker image save "$ref" -o "$tmp/image.tar"
  docker image history --no-trunc --format '{{json .CreatedBy}}' "$ref" > "$tmp/image-history.ndjson"
  history_lines=$(wc -l < "$tmp/image-history.ndjson")
  metadata_exit=0
  {
    cat "$tmp/image-history.ndjson"
    docker image inspect --format '{{json .Config}}' "$ref"
  } | docker run --rm -i --network none -u "$(id -u):$(id -g)" -v "$tmp:/scan" "$gitleaks" stdin \
    --redact=100 --no-banner --exit-code 3 --report-format json --report-path /scan/image-gitleaks.json || metadata_exit=$?
  image_status=PASS
  if [[ "$metadata_exit" == 0 || "$metadata_exit" == 3 ]] &&
     scan_image --scanners vuln,secret,license --format json --output /scan/result.json --input /scan/image.tar &&
     scan_image --format spdx-json --output /scan/sbom.json --input /scan/image.tar; then
    # Secret scanner matches and snippets never leave the temporary directory.
    jq '{SchemaVersion, ArtifactName, Results: [ .Results[]? | {Target, Class, Type, Licenses, Vulnerabilities: [.Vulnerabilities[]? | select(.Severity == "HIGH" or .Severity == "CRITICAL")]} ]}' "$tmp/result.json" > "$output/$image.trivy.json"
    cp "$tmp/sbom.json" "$output/$image.spdx.json"
    c=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' "$tmp/result.json")
    h=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' "$tmp/result.json")
    s=$(jq '[.Results[]?.Secrets[]?] | length' "$tmp/result.json")
    if [[ "$metadata_exit" == 3 ]]; then s=$((s+1)); fi
    if (( s )); then
      # Publish locations and built-in rule IDs only. Never publish matches or snippets.
      jq -c --argjson history "$history_lines" --slurpfile metadata "$tmp/image-gitleaks.json" '
        def rule: if type == "string" and test("^[A-Za-z0-9_.-]{1,80}$") then . else "withheld" end;
        def line: if type == "number" then . else null end;
        def location($match):
          if type == "string" and test("^/?[A-Za-z0-9_@+./:-]{1,440}$") and
             ($match == "" or (contains($match) | not))
          then . else "withheld" end;
        [
          (.Results[]? | .Target as $target | .Secrets[]? | (.Match // "") as $match |
            {scanner:"trivy", ruleId:(.RuleID | rule), source:($target | location($match)), line:(.StartLine | line)}),
          ($metadata[] | .[]? |
            {scanner:"gitleaks", ruleId:(.RuleID | rule),
             source:(if (.StartLine | line) == null then "withheld" elif .StartLine <= $history then "image-history" else "image-config" end),
             line:(.StartLine | line)})
        ]' "$tmp/result.json" > "$output/$image.secret-locations.json"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
        printf '::notice title=Redacted secret locations for %s::%s\n' "$image" "$(cat "$output/$image.secret-locations.json")"
      fi
    fi
    critical=$((critical+c)); secret_count=$((secret_count+s))
    if (( c || s )); then image_status=FAIL; fi
    findings=$(jq -c --arg name "$image" --arg ref "$ref" --arg status "$image_status" --argjson critical "$c" --argjson high "$h" --argjson secrets "$s" \
      '. + {($name): {status:$status,ref:$ref,critical:$critical,high:$high,secrets:$secrets}}' <<<"$findings")
  else
    scan_failed=1
    findings=$(jq -c --arg name "$image" '. + {($name): {status:"BLOCKED"}}' <<<"$findings")
  fi
  rm -f "$tmp/image.tar" "$tmp/result.json" "$tmp/sbom.json" "$tmp/image-history.ndjson" "$tmp/image-gitleaks.json"
done
if (( critical || secret_count || scan_failed )); then decision=1; fi
jq -n --arg sha "$revision" --argjson git "$git_result" --argjson npm "$audit_result" --argjson all "$audit_all_result" \
  --argjson images "$findings" --argjson decision "$decision" \
  '{gitSha:$sha,gitleaksExit:$git,npmProductionExit:$npm,npmAllExit:$all,images:$images,failed:($decision!=0)}' > "$output/scan-gates.json"
printf 'Supply chain summary: %s\n' "$(jq -c . "$output/scan-gates.json")"
if [[ -n "${GITHUB_OUTPUT:-}" && "$git_result" == 0 && "$secret_count" == 0 && "$scan_failed" == 0 ]]; then
  printf 'artifact_safe=true\n' >> "$GITHUB_OUTPUT"
fi
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Supply chain: %s\n' "$(jq -c . "$output/scan-gates.json")" >> "$GITHUB_STEP_SUMMARY"
  printf '::notice title=Supply chain evidence::%s\n' "$(jq -c 'del(.images[].ref)' "$output/scan-gates.json")"
  if (( decision )); then
    printf '::error title=Supply-chain gate blocked::%s\n' "$(jq -c '{gitleaksExit, npmProductionExit, images: (.images | map_values(del(.ref, .status)))}' "$output/scan-gates.json")"
  fi
fi
exit "$decision"
