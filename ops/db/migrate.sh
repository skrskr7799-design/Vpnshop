#!/bin/sh
set -eu
[ "${DATABASE_URL_FILE:-}" = /run/secrets/migrator_url ]
[ -z "${DATABASE_URL:-}" ]
DATABASE_URL="$(cat "$DATABASE_URL_FILE")"
export DATABASE_URL
[ -n "$DATABASE_URL" ]
export PGDATABASE="$DATABASE_URL"
cd /app/apps/api
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
psql --no-psqlrc --quiet --no-password -f /app/ops/db/grants.sql
