# Database setup

The dashboard uses Postgres with two distinct roles:

- `dashboard_rw` — owns and writes to the schema. Used by `/api/internal/*` write paths (connections, notes, readme, favorites).
- `dashboard_ro` — read-only. Used by `/api/internal/*` read paths so a buggy front-end can never DROP TABLE.

## Local development (Docker — recommended)

```sh
docker compose -f compose.dev.yaml up -d
```

This brings up Postgres 16 on `127.0.0.1:5432`. On first launch the init pipeline runs automatically:

1. `db/init/00-init.sh` creates the two roles and the `dashboard_test` database.
2. The same script applies every file in `db/migrations/` (mounted at `/migrations/` inside the container) to both DBs, in lexical order (`001_init.sql` → `002_...` → ...).
3. It transfers ownership of the schema objects to `dashboard_rw` and grants `SELECT` to `dashboard_ro` (including `ALTER DEFAULT PRIVILEGES` so future tables created by `dashboard_rw` — e.g. via direct `psql` migrations — are also readable by ro).

To re-bootstrap from scratch:

```sh
docker compose -f compose.dev.yaml down -v   # WARNING: deletes db_data volume
docker compose -f compose.dev.yaml up -d
```

## Credentials (passwords)

DB passwords come from env vars, consumed **only when the `db_data` volume is first created**:

- `POSTGRES_PASSWORD` — the `postgres` superuser.
- `DASHBOARD_PASSWORD` — the `dashboard_rw` / `dashboard_ro` roles. **Must match** the password embedded in `DATABASE_URL_RW` / `DATABASE_URL_RO`.

`compose.prod.yaml` requires both (startup fails if unset) — set strong values in `.env` before the first `up` (`openssl rand -hex 24`). `compose.dev.yaml` falls back to `postgres` / `CHANGEME` for zero-config local dev.

Because they apply only at first init, **changing them later does not affect an existing volume**. To rotate on a running DB, use `ALTER ROLE`:

```sh
docker compose -f compose.prod.yaml exec postgres \
  psql -U postgres -c "ALTER ROLE dashboard_rw PASSWORD 'NEW'; ALTER ROLE dashboard_ro PASSWORD 'NEW';"
# then update DATABASE_URL_* (and DASHBOARD_PASSWORD) in .env and recreate the api service.
```

## Schema source of truth

`db/migrations/*.sql` is the schema, as an ordered set: `001_init.sql` is the base and each later file is an incremental change. The Docker init script reads them via the `./db/migrations:/migrations:ro` bind mount in `compose.dev.yaml` / `compose.prod.yaml`, so there is nothing to keep in sync.

New migration files should be written to be re-runnable (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, ...) and must set ownership / grants themselves, mirroring what the init script does for the base schema:

```sql
ALTER TABLE    my_new_table        OWNER TO dashboard_rw;
ALTER SEQUENCE my_new_table_id_seq OWNER TO dashboard_rw;  -- if it has a BIGSERIAL
GRANT SELECT ON my_new_table TO dashboard_ro;
```

## Applying a migration to an existing database

**`db/init/00-init.sh` runs only when the `db_data` volume is first created.** Adding a file to `db/migrations/` therefore does *nothing* to a DB that already exists — a plain `up -d` (or `./deploy.sh`) will not pick it up, and the new code will fail at runtime against the old schema.

On an already-running instance, apply new migrations by hand **before** deploying the code that needs them:

```sh
# 1. back up first
docker compose -f compose.prod.yaml exec -T postgres \
  pg_dump -U postgres -d dashboard > dashboard-backup-$(date +%Y%m%d).sql

# 2. check which tables already exist
docker compose -f compose.prod.yaml exec -T postgres \
  psql -U postgres -d dashboard -Atc \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;"

# 3. apply the missing files, in order (they are already mounted at /migrations/)
docker compose -f compose.prod.yaml exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d dashboard -f /migrations/0NN_whatever.sql

# 4. verify ownership + grants landed as expected
docker compose -f compose.prod.yaml exec -T postgres \
  psql -U postgres -d dashboard -c "\dp my_new_table"

# 5. now deploy the code
./deploy.sh
```

There is no migration-tracking table; which files have been applied is determined by inspecting the schema. Use `compose.dev.yaml` and `-d dashboard_test` for the dev / test databases.

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
  for sql in db/migrations/*.sql; do
    psql -U postgres -d "$db" -f "$sql"
  done
  psql -U postgres -d "$db" <<'SQL'
ALTER TABLE    storage_connections     OWNER TO dashboard_rw;
ALTER FUNCTION storage_connections_touch_updated_at() OWNER TO dashboard_rw;
ALTER TABLE    storage_readme_meta     OWNER TO dashboard_rw;
ALTER TABLE    storage_favorite_buckets OWNER TO dashboard_rw;
ALTER TABLE    notes                   OWNER TO dashboard_rw;

GRANT USAGE  ON SCHEMA public                  TO dashboard_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public    TO dashboard_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE dashboard_rw IN SCHEMA public
  GRANT SELECT ON TABLES TO dashboard_ro;
SQL
done
```
