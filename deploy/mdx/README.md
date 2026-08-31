# mdx deployment

`compose.mdx.yaml` runs Mado, Dataset Registry, and Marquez API in one Compose
project and one private bridge network. Marquez UI is intentionally omitted.
Registry and Marquez do not publish host ports. Mado nginx binds its intranet UI
to `127.0.0.1:8080`, and Apache publishes that listener to the mdx LAN. The
dedicated OpenLineage ingest listener binds `127.0.0.1:8081`; it accepts only
`POST /api/openlineage/v1/lineage` and is reserved for a host TLS reverse proxy.
Do not point the public vhost at `:8080`.

Required layout:

```text
/home/mdxuser/mado/
  compose.mdx.yaml
  dataset-registry/
  deploy/mdx/apache-mado.conf
```

Required `.env` keys include the normal Mado production values plus
`REGISTRY_DB_PASSWORD`, `MARQUEZ_DB_PASSWORD`, `REGISTRY_INGEST_TOKEN`,
`LINEAGE_DB_PASSWORD`, `AUTH_MODE`, `AUTH_COOKIE_SECURE`, and
`ALLOWED_ORIGINS`. Do not commit `.env`.

Start databases first when restoring existing data:

```bash
docker compose -f compose.mdx.yaml up -d postgres registry-db marquez-db
# restore verified backups, then apply additive migrations
docker compose -f compose.mdx.yaml up -d --build
```

For an existing Mado database, follow `db/README.md` exactly: backup, apply
missing migrations through 027, start only the new `api-internal`, apply 028
then 029 as the PostgreSQL administrator, enable `mado_lineage` with the
deployment-specific `LINEAGE_DB_PASSWORD`, and only then start `api-lineage`
and the remaining services. Migration 028 removes columns referenced by the
old API; migration 029 removes the untouched known bootstrap credential and
creates the least-privilege role. Do not start the entire new Compose project
before completing this sequence.

Apache requires `proxy` and `proxy_http`. Install the tracked vhost as
`/etc/apache2/sites-available/mado.conf`, disable `000-default`, enable `mado`,
run `apachectl configtest`, then reload Apache.
