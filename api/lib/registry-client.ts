import type {
  DatasetDetail,
  DatasetVersionDetail,
  LineageProjectionStatus,
  LineageRunDetail,
  OpenLineageIngestResult,
  RegistryDatasetSummary,
  RegistryStorageLocationMatch,
  VersionLineageGraph,
} from '../shared/lineage-types.js'
import type { OpenLineageEvent } from './openlineage-schema.js'

export class RegistryClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: 'upstream' | 'timeout' | 'invalid_response',
  ) {
    super(message)
    this.name = 'RegistryClientError'
  }
}

export interface RegistryIngestPrincipal {
  serviceAccountId: string
  keyId: string
  allowedNamespaces: string[]
}

export interface RegistrySearchQuery {
  q: string
  namespace?: string
  limit: number
  offset?: number
}

export interface RegistrySearchResponse {
  results: RegistryDatasetSummary[]
  totalCount: number
}

export interface RegistryManualLocationInput {
  uri: string
  storage_kind: string
  storage_system_key: string
  storage_system_kind: string
  storage_endpoint: string | null
  region: string | null
  bucket: string
  status: 'available' | 'archived' | 'missing' | 'deleted' | 'unknown'
  is_primary: boolean
  metadata: Record<string, unknown>
}

export interface RegistryManualDatasetInput {
  registration_key: string
  dataset_id?: string
  dataset?: Record<string, unknown>
  version: Record<string, unknown>
  locations: RegistryManualLocationInput[]
  source?: Record<string, unknown>
  processing?: Record<string, unknown>
  evidence_refs: string[]
  submitted_by: string
}

export interface RegistryManualLineageInput extends Record<string, unknown> {
  run_key: string
  submitted_by: string
}

export interface RegistryDatasetUpdateInput {
  displayName?: string | null
  aliases?: string[]
  description?: string | null
  mediaType?: string | null
  owner?: string | null
}

export interface RegistryClient {
  ingestOpenLineage(
    event: OpenLineageEvent,
    principal: RegistryIngestPrincipal,
  ): Promise<OpenLineageIngestResult>
  resolveDatasets(
    refs: ReadonlyArray<{ namespace: string; name: string }>,
  ): Promise<RegistryDatasetSummary[]>
  searchDatasets(query: RegistrySearchQuery): Promise<RegistrySearchResponse>
  resolveStorageLocation(
    storageSystemKey: string,
    uri: string,
    limit?: number,
  ): Promise<{ uri: string; matches: RegistryStorageLocationMatch[]; totalCount: number }>
  getDataset(id: string): Promise<DatasetDetail>
  updateDataset(id: string, input: RegistryDatasetUpdateInput): Promise<DatasetDetail>
  getVersion(id: string): Promise<DatasetVersionDetail>
  getRun(id: string): Promise<LineageRunDetail>
  getVersionGraph(
    versionId: string,
    direction: 'upstream' | 'downstream' | 'both',
    depth: number,
  ): Promise<VersionLineageGraph>
  getProjectionStatus(): Promise<LineageProjectionStatus>
  registerManualDataset(input: RegistryManualDatasetInput): Promise<Record<string, unknown>>
  registerManualLocation(input: {
    version_id: string
    location: RegistryManualLocationInput
    evidence_refs: string[]
    submitted_by: string
  }): Promise<Record<string, unknown>>
  registerManualLineage(input: RegistryManualLineageInput): Promise<Record<string, unknown>>
}

export interface RegistryClientOptions {
  baseUrl: string
  token: string
  timeoutMs?: number
  fetch?: typeof fetch
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RegistryClientError('Registry returned an invalid object', 502, 'invalid_response')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, fallback: string | null = null): string | null {
  return typeof value === 'string' ? value : fallback
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function datasetSummary(value: unknown): RegistryDatasetSummary {
  const row = record(value)
  const id = text(row.datasetId ?? row.dataset_id ?? row.id)
  const namespace = text(row.namespace)
  const name = text(row.name)
  if (!namespace || !name) {
    throw new RegistryClientError('Registry dataset identity is missing', 502, 'invalid_response')
  }
  return {
    kind: row.kind === 'source' ? 'source' : 'dataset',
    datasetId: id,
    datasetKey: text(row.datasetKey ?? row.dataset_key),
    namespace,
    name,
    displayName: text(row.displayName ?? row.display_name),
    aliases: Array.isArray(row.aliases)
      ? row.aliases.filter((item): item is string => typeof item === 'string') : [],
    description: text(row.description),
    mediaType: text(row.mediaType ?? row.media_type),
    owner: text(row.owner),
    currentVersionId: text(row.currentVersionId ?? row.current_version_id),
    versionCount: Number(row.versionCount ?? row.version_count ?? 0) || 0,
  }
}

function storageLocationMatch(value: unknown): RegistryStorageLocationMatch {
  const row = record(value)
  const dataset = datasetSummary(row)
  const versionId = text(row.versionId ?? row.version_id)
  const version = text(row.version)
  const locationId = text(row.locationId ?? row.location_id)
  const locationUri = text(row.locationUri ?? row.location_uri)
  if (!versionId || !version || !locationId || !locationUri) {
    throw new RegistryClientError('Registry storage location match is invalid', 502, 'invalid_response')
  }
  const rawStatus = text(row.status, 'unknown')!
  const status = ['available', 'archived', 'missing', 'deleted', 'unknown'].includes(rawStatus)
    ? rawStatus as RegistryStorageLocationMatch['status'] : 'unknown'
  return {
    ...dataset,
    versionId,
    version,
    versionCreatedAt: text(row.versionCreatedAt ?? row.version_created_at, '')!,
    locationId,
    locationUri,
    status,
    isPrimary: row.isPrimary === true || row.is_primary === true,
    observedAt: text(row.observedAt ?? row.observed_at, '')!,
    matchType: (row.matchType ?? row.match_type) === 'exact' ? 'exact' : 'prefix',
  }
}

function storageLocation(value: unknown): DatasetVersionDetail['locations'][number] {
  const row = record(value)
  const id = text(row.id)
  const uri = text(row.uri)
  if (!id || !uri) {
    throw new RegistryClientError('Registry storage location is invalid', 502, 'invalid_response')
  }
  const rawStatus = text(row.status, 'unknown')!
  const status = ['available', 'archived', 'missing', 'deleted', 'unknown'].includes(rawStatus)
    ? rawStatus as DatasetVersionDetail['locations'][number]['status']
    : 'unknown'
  return {
    id,
    uri,
    storageKind: text(row.storageKind ?? row.storage_kind, 'other')!,
    storageSystemKey: text(row.storageSystemKey ?? row.storage_system_key),
    region: text(row.region),
    bucket: text(row.bucket),
    status,
    isPrimary: row.isPrimary === true || row.is_primary === true,
    observedAt: text(row.observedAt ?? row.observed_at, '')!,
    madoConnectionId: text(row.madoConnectionId ?? row.mado_connection_id),
    metadata: objectValue(row.metadata),
  }
}

function datasetVersion(value: unknown): DatasetVersionDetail {
  const row = record(value)
  const id = text(row.id ?? row.versionId ?? row.version_id)
  const datasetId = text(row.datasetId ?? row.dataset_id)
  const version = text(row.version)
  if (!id || !datasetId || !version) {
    throw new RegistryClientError('Registry dataset version is invalid', 502, 'invalid_response')
  }
  return {
    id,
    datasetId,
    version,
    contentHash: text(row.contentHash ?? row.content_hash),
    manifestUri: text(row.manifestUri ?? row.manifest_uri),
    manifestHash: text(row.manifestHash ?? row.manifest_hash),
    schemaUri: text(row.schemaUri ?? row.schema_uri),
    createdAt: text(row.createdAt ?? row.created_at, '')!,
    metadata: objectValue(row.metadata),
    locations: Array.isArray(row.locations) ? row.locations.map(storageLocation) : [],
  }
}

function datasetDetail(value: unknown): DatasetDetail {
  const row = record(value)
  const summary = datasetSummary(row)
  return {
    ...summary,
    createdAt: text(row.createdAt ?? row.created_at, '')!,
    versions: Array.isArray(row.versions) ? row.versions.map(datasetVersion) : [],
  }
}

function runDatasetRef(value: unknown): LineageRunDetail['inputs'][number] {
  const row = record(value)
  return {
    versionId: text(row.versionId ?? row.version_id, '')!,
    version: text(row.version, '')!,
    namespace: text(row.namespace, '')!,
    name: text(row.name, '')!,
    primaryUri: text(row.primaryUri ?? row.primary_uri),
    storageKind: text(row.storageKind ?? row.storage_kind),
  }
}

function runDetail(value: unknown): LineageRunDetail {
  const row = record(value)
  const rawStatus = text(row.status, 'RUNNING')!
  const status = ['RUNNING', 'COMPLETE', 'FAIL', 'ABORT'].includes(rawStatus)
    ? rawStatus as LineageRunDetail['status']
    : 'RUNNING'
  return {
    id: text(row.id, '')!,
    runKey: text(row.runKey ?? row.run_key, '')!,
    jobNamespace: text(row.jobNamespace ?? row.job_namespace, '')!,
    jobName: text(row.jobName ?? row.job_name, '')!,
    status,
    startedAt: text(row.startedAt ?? row.started_at, '')!,
    endedAt: text(row.endedAt ?? row.ended_at),
    createdAt: text(row.createdAt ?? row.created_at),
    gitSha: text(row.gitSha ?? row.git_sha),
    containerDigest: text(row.containerDigest ?? row.container_digest),
    configUri: text(row.configUri ?? row.config_uri),
    configHash: text(row.configHash ?? row.config_hash),
    modelRefs: Array.isArray(row.modelRefs ?? row.model_refs)
      ? (row.modelRefs ?? row.model_refs) as Record<string, unknown>[] : [],
    runtime: objectValue(row.runtime),
    metrics: objectValue(row.metrics),
    errorMessage: text(row.errorMessage ?? row.error_message),
    inputs: Array.isArray(row.inputs) ? row.inputs.map(runDatasetRef) : [],
    outputs: Array.isArray(row.outputs) ? row.outputs.map(runDatasetRef) : [],
    sources: Array.isArray(row.sources) ? row.sources.map(objectValue) : [],
  }
}

function endpoint(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(path.replace(/^\//, ''), base)
}

export function createRegistryClient(options: RegistryClientOptions): RegistryClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5_000

  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    let response: Response
    try {
      response = await doFetch(endpoint(options.baseUrl, path), {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${options.token}`,
          ...init.headers,
        },
      })
    } catch (error) {
      const timeout = error instanceof Error && (
        error.name === 'TimeoutError' || error.name === 'AbortError'
      )
      throw new RegistryClientError(
        timeout ? 'Registry request timed out' : 'Registry is unavailable',
        503,
        timeout ? 'timeout' : 'upstream',
      )
    }

    if (!response.ok) {
      // Do not copy arbitrary upstream details into a response: Registry
      // metadata can contain contract and storage references.
      throw new RegistryClientError(`Registry returned HTTP ${response.status}`, response.status, 'upstream')
    }
    try {
      return await response.json() as T
    } catch {
      throw new RegistryClientError('Registry returned invalid JSON', 502, 'invalid_response')
    }
  }

  return {
    ingestOpenLineage: (event, principal) => request('/v1/ingest/openlineage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, principal }),
    }),

    resolveDatasets: refs => refs.length === 0
      ? Promise.resolve([])
      : request('/v1/resolve/datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasets: refs }),
      }).then((body: unknown) => {
        if (Array.isArray(body)) return body.map(datasetSummary)
        const wrapped = record(body)
        return Array.isArray(wrapped.datasets) ? wrapped.datasets.map(datasetSummary) : []
      }),

    searchDatasets: query => {
      const url = endpoint(options.baseUrl, '/v1/search/datasets')
      url.searchParams.set('q', query.q)
      url.searchParams.set('limit', String(query.limit))
      if (query.namespace) url.searchParams.set('namespace', query.namespace)
      if (query.offset) url.searchParams.set('offset', String(query.offset))
      return request<unknown>(url.toString()).then(body => {
        const wrapped = record(body)
        const results = Array.isArray(wrapped.results) ? wrapped.results.map(datasetSummary) : []
        return { results, totalCount: Number(wrapped.totalCount ?? wrapped.total_count ?? results.length) }
      })
    },

    resolveStorageLocation: (storageSystemKey, uri, limit = 20) => {
      const url = endpoint(options.baseUrl, '/v1/resolve/storage-location')
      url.searchParams.set('storage_system_key', storageSystemKey)
      url.searchParams.set('uri', uri)
      url.searchParams.set('limit', String(limit))
      return request<unknown>(url.toString()).then(body => {
        const wrapped = record(body)
        const matches = Array.isArray(wrapped.matches)
          ? wrapped.matches.map(storageLocationMatch) : []
        return {
          uri: text(wrapped.uri, uri)!,
          matches,
          totalCount: Number(wrapped.totalCount ?? wrapped.total_count ?? matches.length),
        }
      })
    },

    getDataset: id => request<unknown>(`/v1/datasets/${encodeURIComponent(id)}`).then(datasetDetail),
    updateDataset: async (id, input) => {
      const path = `/v1/datasets/${encodeURIComponent(id)}`
      await request(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
          ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.mediaType !== undefined ? { media_type: input.mediaType } : {}),
          ...(input.owner !== undefined ? { owner: input.owner } : {}),
        }),
      })
      return request<unknown>(path).then(datasetDetail)
    },
    getVersion: id => request<unknown>(`/v1/dataset-versions/${encodeURIComponent(id)}`).then(datasetVersion),
    getRun: id => request<unknown>(`/v1/runs/${encodeURIComponent(id)}`).then(runDetail),

    getVersionGraph: (versionId, direction, depth) => {
      const url = endpoint(options.baseUrl, `/v1/graph/dataset-versions/${encodeURIComponent(versionId)}`)
      url.searchParams.set('direction', direction)
      url.searchParams.set('depth', String(depth))
      return request(url.toString())
    },

    getProjectionStatus: () => request<unknown>('/v1/projection-status').then(value => {
      const row = record(value)
      const pending = Number(row.pendingEvents ?? row.pending_events ?? 0)
      const rawState = text(row.state, pending > 0 ? 'lagging' : 'synced')!
      const state = ['synced', 'lagging', 'unavailable'].includes(rawState)
        ? rawState as LineageProjectionStatus['state']
        : pending > 0 ? 'lagging' : 'synced'
      return {
        state,
        pendingEvents: Number.isFinite(pending) ? pending : null,
        oldestPendingAt: text(row.oldestPendingAt ?? row.oldest_pending_at),
        ...(typeof row.message === 'string' ? { message: row.message } : {}),
      }
    }),

    registerManualDataset: input => request('/v1/manual/datasets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

    registerManualLocation: input => request('/v1/manual/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

    registerManualLineage: input => request('/v1/manual/lineage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  }
}
