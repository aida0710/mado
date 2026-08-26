# mdx deployment

`compose.mdx.yaml` runs Mado, Dataset Registry, and Marquez API in one Compose
project and one private bridge network. Marquez UI is intentionally omitted.
Registry and Marquez do not publish host ports; only Mado nginx binds
`127.0.0.1:8080`, and Apache publishes the application to the mdx LAN.

Required layout:

```text
/home/mdxuser/mado/
  compose.mdx.yaml
  dataset-registry/
  deploy/mdx/apache-mado.conf
```

Required `.env` keys include the normal Mado production values plus
`REGISTRY_DB_PASSWORD`, `MARQUEZ_DB_PASSWORD`, `REGISTRY_INGEST_TOKEN`,
`AUTH_MODE`, `AUTH_COOKIE_SECURE`, and `ALLOWED_ORIGINS`. Do not commit `.env`.

Start databases first when restoring existing data:

```bash
docker compose -f compose.mdx.yaml up -d postgres registry-db marquez-db
# restore verified backups, then apply additive migrations
docker compose -f compose.mdx.yaml up -d --build
```

Apache requires `proxy` and `proxy_http`. Install the tracked vhost as
`/etc/apache2/sites-available/mado.conf`, disable `000-default`, enable `mado`,
run `apachectl configtest`, then reload Apache.
