# Database setup

The dashboard uses Postgres with two distinct roles:

- `dashboard_rw` — owns and writes to the schema. Used by `/sql/write` and `/api/hpc/push`.
- `dashboard_ro` — read-only. Used by `/api/*` read paths so a buggy front-end can never DROP TABLE.

## Local development (Docker — recommended)

```sh
docker compose up -d
```

This brings up Postgres 16 on `localhost:5432`. On first launch the init scripts in `db/init/` run automatically:

1. `00-init.sh` creates the two roles and the `dashboard_test` database.
2. `01-schema.sql` creates the schema in both `dashboard` and `dashboard_test`.
3. `00-init.sh` then grants `SELECT` on all current and future tables to `dashboard_ro`.

To re-bootstrap from scratch:

```sh
docker compose down -v   # WARNING: deletes db_data volume
docker compose up -d
```

## Schema source of truth

`server/migrations/001_init.sql` is the canonical schema. It is duplicated at `db/init/01-schema.sql` for the Docker init pipeline. When changing the schema, edit BOTH files (or eventually replace this with a single-file migration runner).

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
GRANT USAGE  ON SCHEMA public                       TO dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public         TO dashboard_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO dashboard_ro;
SQL
done
```
