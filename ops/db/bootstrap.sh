#!/bin/sh
# Runs only in the official image's initdb path.
set -eu
for role in migrator public admin worker billing notifications backup monitor; do
    secret="$(cat "/run/secrets/db_$role")"
    [ -n "$secret" ]
    MZT_ROLE="mzt_$role" MZT_PASSWORD="$secret" psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --username postgres --dbname postgres <<'SQL'
\getenv role MZT_ROLE
\getenv password MZT_PASSWORD
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  :'role', :'password') \gexec
SQL
done
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --username postgres --dbname postgres <<'SQL'
REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC;
REVOKE ALL ON DATABASE vpnshop FROM PUBLIC;
ALTER DATABASE vpnshop OWNER TO mzt_migrator;
GRANT CONNECT ON DATABASE vpnshop TO mzt_public,mzt_admin,mzt_worker,mzt_billing,mzt_notifications,mzt_backup,mzt_monitor;
SQL
