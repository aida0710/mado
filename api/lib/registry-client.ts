import type {
  DatasetDetail,
  DatasetVersionDetail,
  LineageProjectionStatus,
  LineageRunDetail,
  OpenLineageIngestResult,
  RegistryDatasetSummary,
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
}

export interface RegistrySearchResponse {
  results: RegistryDatasetSummary[]
  totalCount: number
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
  getDataset(id: string): Promise<DatasetDetail>
  getVersion(id: string): Promise<DatasetVersionDetail>
  getRun(id: string): Promise<LineageRunDetail>
  getVersionGraph(
    versionId: string,
    direction: 'upstream' | 'downstream' | 'both',
    depth: number,
  ): Promise<VersionLineageGraph>
  getProjectionStatus(): Promise<LineageProjectionStatus>
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
    description: text(row.description),
    mediaType: text(row.mediaType ?? row.media_type),
    owner: text(row.owner),
    currentVersionId: text(row.currentVersionId ?? row.current_version_id),
    versionCount: Number(row.versionCount ?? row.version_count ?? 0) || 0,
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
      return request<unknown>(url.toString()).then(body => {
        const wrapped = record(body)
        const results = Array.isArray(wrapped.results) ? wrapped.results.map(datasetSummary) : []
        return { results, totalCount: Number(wrapped.totalCount ?? wrapped.total_count ?? results.length) }
      })
    },

    getDataset: id => request<unknown>(`/v1/datasets/${encodeURIComponent(id)}`).then(datasetDetail),
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
  }
}
