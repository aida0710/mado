# Database setup

The dashboard uses Postgres with two distinct roles:

- `dashboard_rw` — owns and writes to the schema. Used by `/sql/write` and `/api/hpc/push`.
- `dashboard_ro` — read-only. Used by `/api/*` read paths so a buggy front-end can never DROP TABLE.

## Local development (Docker — recommended)

```sh
docker compose up -d
```

This brings up Postgres 16 on `127.0.0.1:5432`. On first launch the init pipeline runs automatically:

1. `db/init/00-init.sh` creates the two roles and the `dashboard_test` database.
2. The same script applies the canonical schema (`server/migrations/001_init.sql`, mounted at `/migrations/` inside the container) to both DBs.
3. It transfers ownership of the schema objects to `dashboard_rw` and grants `SELECT` to `dashboard_ro` (including `ALTER DEFAULT PRIVILEGES` so future tables created by `dashboard_rw` via `/sql/write` are also readable by ro).

To re-bootstrap from scratch:

```sh
docker compose down -v   # WARNING: deletes db_data volume
docker compose up -d
```

## Schema source of truth

`server/migrations/001_init.sql` is the only schema file. The Docker init script reads it via the `./server/migrations:/migrations:ro` bind mount in `compose.yml`, so there is nothing to keep in sync.

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
  psql -U postgres -d "$db" -f server/migrations/001_init.sql
  psql -U postgres -d "$db" <<'SQL'
ALTER TABLE    hpc_metrics        OWNER TO dashboard_rw;
ALTER SEQUENCE hpc_metrics_id_seq OWNER TO dashboard_rw;
ALTER VIEW     hpc_metrics_latest OWNER TO dashboard_rw;
ALTER TABLE    s3_readme_meta     OWNER TO dashboard_rw;

GRANT USAGE  ON SCHEMA public                  TO dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public    TO dashboard_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_rw IN SCHEMA public
  GRANT SELECT ON TABLES TO dashboard_ro;
SQL
done
```
