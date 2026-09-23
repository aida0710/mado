# mdx deployment

`compose.mdx.yaml` runs Mado, Dataset Registry, and Marquez API in one Compose
project and one private bridge network. Marquez UI is intentionally omitted.
Registry and Marquez do not publish host ports. Mado nginx binds its intranet UI
to `127.0.0.1:8080`, and Apache publishes that listener to the mdx LAN. The
dedicated OpenLineage ingest listener binds `127.0.0.1:8081`; it accepts only
`POST /api/openlineage/v1/lineage` and is reserved for a host TLS reverse proxy.
Do not point the public vhost at `:8080`.

## Prometheus metrics

Service Account keys read Mado's own data under `/api/mado/`; every route
there is read-only and nginx passes only GET. Prometheus reads Mado metrics from
the intranet host at `https://mado.internal.dubguild.com/api/mado/metrics/<area>`.
Each area has its own path so that it can be scraped at a rate that matches how
fast it changes; bucket capacity (the "容量メトリクス" screen) is served at
`/api/mado/metrics/capacity`. The route goes through the
same edge TLS vhost, intranet CIDR ACL, and `127.0.0.1:8080` nginx listener as
the web UI. No extra host port is published: a Docker-published port bypasses
UFW through DNAT, so the host firewall could not restrict it. The public
OpenLineage listener (`:8081`) returns 404 for these paths. The Prometheus host
must be inside the edge ACL and resolve the private DNS name.

Scraping requires a Service Account key with the `metrics:read` scope. Issue it
in Settings → Access → Service Accounts with the purpose
`Prometheus収集（metrics:read）`. Keys that return Mado data are read-only. Do
not reuse an OpenLineage (`lineage:write`) key; each key carries only the scope
it needs. A `metrics:read` key reads every connection's bucket names and sizes,
including connections limited by a user allowlist, so decide who can view the
Grafana dashboards with that in mind.

```yaml
scrape_configs:
  - job_name: mado-capacity
    # Capacity changes at most every 6 hours, but stay within Prometheus'
    # 5-minute lookback so the series does not go stale between scrapes.
    scrape_interval: 2m
    scheme: https
    metrics_path: /api/mado/metrics/capacity
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/mado-metrics-key
    static_configs:
      - targets: ['mado.internal.dubguild.com']
```

`/api/mado/metrics/capacity` exports each bucket's latest saved scan result as
`mado_storage_bucket_bytes` and `mado_storage_bucket_objects`, along with
`mado_storage_capacity_collection_age_seconds` and
`mado_storage_capacity_collection_failures` (labels `connection_id` and
`bucket`). Buckets without a successful scan have no size, object count, or age
sample; failed scans leave the last successful values in place. Scraping does
not initiate a scan. Enable capacity tracking for a connection or run a manual
capacity scan in Mado to populate results.

Per connection, `mado_storage_connection_info{connection_id,connection_name}`
is always 1 and maps the opaque ID to its name, and
`mado_storage_capacity_tracking_enabled` and
`mado_storage_capacity_tracking_interval_seconds` describe scheduled tracking.
If the saved values cannot be read, the path returns 503 and Prometheus reports
`up{job="mado-capacity"} == 0`. To alert on stale scans only where tracking is
on:

```promql
mado_storage_capacity_collection_age_seconds
  > on (connection_id) group_left
    2 * mado_storage_capacity_tracking_interval_seconds
  and on (connection_id)
    mado_storage_capacity_tracking_enabled == 1
```

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
