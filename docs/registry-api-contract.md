# Dataset Registry API contract for Mado v1.0.0

Mado v1.0.0 does not distribute an official Dataset Registry implementation.
The OpenLineage endpoint and browser lineage features require an operator-
supplied service that implements this contract. The Registry operator is also
responsible for issuing and rotating the Bearer token; Mado does not create it.
This document defines Mado's integration surface, not a complete standalone
Registry implementation specification; v1.0.0 does not promise that a new
third-party Registry can be built from this document alone.

## Transport and authentication

- `DATASET_REGISTRY_URL` is the base URL. Production deployments must use a
  trusted private network or HTTPS.
- Every request sends `Authorization: Bearer <DATASET_REGISTRY_TOKEN>` and
  `Accept: application/json`. The token must be at least 16 characters and
  should be dedicated to Mado with only ingest, read, and manual-registration
  permissions.
- JSON requests send `Content-Type: application/json`. All successful API
  responses must be JSON and use a 2xx status. Mado treats other statuses,
  invalid JSON, and a five-second timeout as Registry failure.
- The operator must provide `GET /healthz` returning 2xx for installation
  preflight. Mado's runtime does not use this endpoint as authorization proof.

## Required endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/ingest/openlineage` | Store `{ event, principal }`; principal contains service-account/key IDs and allowed namespaces |
| `POST` | `/v1/resolve/datasets` | Resolve `{ datasets: [{ namespace, name }] }` |
| `GET` | `/v1/search/datasets?q=&limit=&namespace=&offset=` | Search datasets |
| `GET` | `/v1/resolve/storage-location?storage_system_key=&uri=&limit=` | Resolve a storage URI |
| `GET` | `/v1/datasets/{id}` | Dataset detail |
| `GET` | `/v1/dataset-versions/{id}` | Version detail and locations |
| `GET` | `/v1/runs/{id}` | Run detail and input/output versions |
| `GET` | `/v1/graph/dataset-versions/{id}?direction=&depth=` | Version lineage graph |
| `GET` | `/v1/projection-status` | Projection state (`synced`, `lagging`, or `unavailable`) |
| `POST` | `/v1/manual/datasets` | Register a manually curated dataset/version/location |
| `POST` | `/v1/manual/locations` | Register a location for an existing version |
| `POST` | `/v1/manual/lineage` | Register manually curated lineage |

Dataset summaries must contain non-empty `namespace` and `name`. Version
responses must contain `id`, `datasetId` (or `dataset_id`), and `version`.
Storage matches must additionally contain version/location IDs, version, and
location URI. Responses may use camelCase or the documented snake_case aliases.
Unknown additional fields are ignored.

Before starting Mado, validate both health and token authentication against the
chosen implementation. A health-only stub is not compatible: all endpoints
used by the enabled Mado features must satisfy this contract.
