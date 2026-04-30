#!/usr/bin/env bash
set -euo pipefail

# Runs once on first container creation. Re-running requires deleting the
# named volume `db_data`.

PASSWORD="${DASHBOARD_PASSWORD:?DASHBOARD_PASSWORD must be set in compose.yml}"

# Roles + the test DB. The default `dashboard` DB was created from POSTGRES_DB.
psql -v ON_ERROR_STOP=1 --username "postgres" <<-EOSQL
  CREATE ROLE dashboard_rw LOGIN PASSWORD '${PASSWORD}';
  CREATE ROLE dashboard_ro LOGIN PASSWORD '${PASSWORD}';

  CREATE DATABASE dashboard_test OWNER postgres;

  GRANT ALL ON DATABASE dashboard      TO dashboard_rw;
  GRANT ALL ON DATABASE dashboard_test TO dashboard_rw;
  GRANT CONNECT ON DATABASE dashboard      TO dashboard_ro;
  GRANT CONNECT ON DATABASE dashboard_test TO dashboard_ro;
EOSQL

# Apply the schema to both DBs.
for db in dashboard dashboard_test; do
  psql -v ON_ERROR_STOP=1 --username "postgres" --dbname "$db" \
    -f /docker-entrypoint-initdb.d/01-schema.sql

  # Grant ro access on every existing and future table in public.
  psql -v ON_ERROR_STOP=1 --username "postgres" --dbname "$db" <<-EOSQL
    GRANT USAGE  ON SCHEMA public                       TO dashboard_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public         TO dashboard_ro;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT ON TABLES TO dashboard_ro;
EOSQL
done
