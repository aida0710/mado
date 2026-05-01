# Database setup

The dashboard uses Postgres with two distinct roles:

- `dashboard_rw` — owns and writes to the schema. Used by `/api/external/metrics/push` and the internal write paths (connections, notes, settings, readme, favorites).
- `dashboard_ro` — read-only. Used by `/api/internal/*` read paths so a buggy front-end can never DROP TABLE.

## Local development (Docker — recommended)

```sh
docker compose -f compose.dev.yaml up -d
```

This brings up Postgres 16 on `127.0.0.1:5432`. On first launch the init pipeline runs automatically:

1. `db/init/00-init.sh` creates the two roles and the `dashboard_test` database.
2. The same script applies the canonical schema (`db/migrations/001_init.sql`, mounted at `/migrations/` inside the container) to both DBs.
3. It transfers ownership of the schema objects to `dashboard_rw` and grants `SELECT` to `dashboard_ro` (including `ALTER DEFAULT PRIVILEGES` so future tables created by `dashboard_rw` — e.g. via direct `psql` migrations — are also readable by ro).

To re-bootstrap from scratch:

```sh
docker compose -f compose.dev.yaml down -v   # WARNING: deletes db_data volume
docker compose -f compose.dev.yaml up -d
```

## Schema source of truth

`db/migrations/001_init.sql` is the only schema file. The Docker init script reads it via the `./db/migrations:/migrations:ro` bind mount in `compose.dev.yaml` / `compose.prod.yaml`, so there is nothing to keep in sync.

## Manual setup (non-Docker)

If you don't use Docker, do the equivalent by hand against any local Postgres 14+:

```sh
psql -U postgres <<'SQL'
CREATE DATABASE dashboard;
CREATE DATABASE dashboard_test;
CREATE ROLE dashboard_rw LOGIN PASSWORD 'CHANGEME';
CREATE ROLE dashboard_ro LOGIN PASSWORD 'CHANGEME';
GRANT ALL ON DATABASE dashboard       TO dashboard_rw;
GRANT ALL ON DATABASE dashboard_test  TO dashboard_rw;
GRANT CONNECT ON DATABASE dashboard      TO dashboard_ro;
GRANT CONNECT ON DATABASE dashboard_test TO dashboard_ro;
SQL

for db in dashboard dashboard_test; do
  psql -U postgres -d "$db" -f db/migrations/001_init.sql
  psql -U postgres -d "$db" <<'SQL'
ALTER TABLE    metrics             OWNER TO dashboard_rw;
ALTER SEQUENCE metrics_id_seq      OWNER TO dashboard_rw;
ALTER VIEW     metrics_latest      OWNER TO dashboard_rw;
ALTER TABLE    storage_readme_meta OWNER TO dashboard_rw;

GRANT CREATE ON SCHEMA public                  TO dashboard_rw;
GRANT USAGE  ON SCHEMA public                  TO dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public    TO dashboard_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_rw IN SCHEMA public
  GRANT SELECT ON TABLES TO dashboard_ro;
SQL
done
```
