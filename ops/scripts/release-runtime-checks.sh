#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
revision=$(git rev-parse HEAD)
MZT_V2_SMOKE=1 MZT_V2_CLI_SMOKE=1 ops/scripts/smoke.sh
MZT_DRILL_REPO=s3 ops/scripts/pitr.sh
MZT_V2_EDGE_IMAGE="mzt-ci-edge:$revision" PYTHONDONTWRITEBYTECODE=1 python3 ops/scripts/v2_tls_smoke.py
