# Mado release bundle

This archive installs a tagged Mado release from pre-built OCI images. It does
not build application source on the deployment host.

## New installation

1. Copy `.env.example` to `.env`.
2. Replace every placeholder or empty secret in `.env`. Keep
   `DATABASE_URL_RW`, `DATABASE_URL_RO`, and `DASHBOARD_PASSWORD` consistent.
3. Choose `AUTH_MODE=local`, `oidc`, or `hybrid`. Keep `MADO_ENV=production`;
   keep `AUTH_COOKIE_SECURE=true` whenever browser access uses TLS.
4. Provide a compatible Dataset Registry API and token. It is an external
   prerequisite and is not contained in this archive; Marquez is optional for
   the browser graph. No official Registry distribution is included in Mado
   v1.0.0. Use `REGISTRY_API_CONTRACT.md` to validate an existing external
   service and obtain its Bearer token from that service's operator. Leave
   neither Registry value blank.
5. Run `docker compose -f compose.yaml config` and review the resolved config.
6. Start only PostgreSQL, then create the first administrator while no Web
   listener exists:

   ```bash
   docker compose -f compose.yaml up -d postgres
   docker compose -f compose.yaml run --rm api-internal \
     node dist/scripts/bootstrap-admin.js --username admin
   ```

7. Run `docker compose -f compose.yaml up -d`.
8. Put an intranet TLS proxy in front of `127.0.0.1:8080`. If Pipeline ingest
   is public, use a separate TLS hostname pointing only to `127.0.0.1:8081`.

The generated `compose.yaml` pins Mado images by digest. `images.txt` records
the same immutable references. Do not point a public proxy at port 8080.

## Existing database

The PostgreSQL init directory runs only for a new volume. For an existing DB,
follow the single ordered procedure in `db/README.md`: backup, apply missing
files through 027, start only the new `api-internal`, apply 028 then 029, enable
the `mado_lineage` login with `LINEAGE_DB_PASSWORD`, and only then start
`api-lineage` and the remaining services. Do not bring up the entire new
Compose project before completing those steps.

Internal/private deployments are downstream operations. Publishing an OSS
release never connects to or changes a deployment environment.
