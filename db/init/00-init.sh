#!/usr/bin/env bash
set -euo pipefail

# Runs once on first container creation. Re-running requires deleting the
# named volume `db_data`.

PASSWORD="${DASHBOARD_PASSWORD:?DASHBOARD_PASSWORD must be set in compose.dev.yaml or compose.prod.yaml}"

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

# Apply the schema to both DBs. The canonical schema lives at
# db/migrations/001_init.sql; compose mounts it at /migrations/.
for db in dashboard dashboard_test; do
  psql -v ON_ERROR_STOP=1 --username "postgres" --dbname "$db" \
    -f /migrations/001_init.sql

  # Transfer ownership of the schema objects to dashboard_rw so it can
  # TRUNCATE / ALTER / DROP them as needed (GRANT alone is not enough for
  # operations like TRUNCATE ... RESTART IDENTITY).
  # rw also gets CREATE on schema public so /sql/write can create new tables.
  # ro keeps SELECT-only access via explicit GRANT.
  psql -v ON_ERROR_STOP=1 --username "postgres" --dbname "$db" <<-EOSQL
    ALTER TABLE    metrics                              OWNER TO dashboard_rw;
    ALTER SEQUENCE metrics_id_seq                       OWNER TO dashboard_rw;
    ALTER VIEW     metrics_latest                       OWNER TO dashboard_rw;
    ALTER TABLE    storage_connections                  OWNER TO dashboard_rw;
    ALTER FUNCTION storage_connections_touch_updated_at() OWNER TO dashboard_rw;
    ALTER TABLE    storage_readme_meta                  OWNER TO dashboard_rw;
    ALTER TABLE    storage_favorite_buckets             OWNER TO dashboard_rw;
    ALTER TABLE    notes                                OWNER TO dashboard_rw;
    ALTER TABLE    feature_flags                        OWNER TO dashboard_rw;

    GRANT CREATE ON SCHEMA public                  TO dashboard_rw;
    GRANT USAGE  ON SCHEMA public                  TO dashboard_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA public    TO dashboard_ro;
    ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_rw IN SCHEMA public
      GRANT SELECT ON TABLES TO dashboard_ro;
EOSQL
done
