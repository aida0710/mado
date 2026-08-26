export type LineageNodeKind = 'dataset' | 'job' | 'source'
export type LineageEdgeKind = 'input' | 'output' | 'lineage'

export interface LineageNodeRef {
  kind: 'dataset' | 'job'
  namespace: string
  name: string
  nodeId: string
}

export interface RegistryDatasetSummary {
  kind: 'dataset' | 'source'
  datasetId: string | null
  datasetKey: string | null
  namespace: string
  name: string
  displayName: string | null
  aliases: string[]
  description: string | null
  mediaType: string | null
  owner: string | null
  currentVersionId: string | null
  versionCount: number
}

export interface RegistryStorageLocationMatch extends RegistryDatasetSummary {
  versionId: string
  version: string
  versionCreatedAt: string
  locationId: string
  locationUri: string
  status: 'available' | 'archived' | 'missing' | 'deleted' | 'unknown'
  isPrimary: boolean
  observedAt: string
  matchType: 'exact' | 'prefix'
}

export interface StorageLineageResolution {
  storageSystemKey: string | null
  uri: string
  matches: RegistryStorageLocationMatch[]
}

export interface LogicalLineageNode {
  /** Marquez node ID. It is opaque: callers must not split it on `:`. */
  id: string
  kind: LineageNodeKind
  namespace: string
  name: string
  label: string
  updatedAt: string | null
  completeness: 'complete' | 'partial' | 'unregistered'
  registry: RegistryDatasetSummary | null
  latestRun: {
    id: string | null
    state: string | null
    startedAt: string | null
    endedAt: string | null
  } | null
}

export interface LogicalLineageEdge {
  id: string
  source: string
  target: string
  kind: LineageEdgeKind
}

export interface LineageProjectionStatus {
  state: 'synced' | 'lagging' | 'unavailable'
  pendingEvents: number | null
  oldestPendingAt: string | null
  message?: string
}

export interface LogicalLineageGraph {
  root: LineageNodeRef
  nodes: LogicalLineageNode[]
  edges: LogicalLineageEdge[]
  projection: LineageProjectionStatus
  warnings: string[]
}

export interface VersionGraphNode {
  id: string
  kind: 'source' | 'version' | 'run'
  label: string
  data: Record<string, unknown>
}

export interface VersionGraphEdge {
  id: string
  source: string
  target: string
  kind: 'acquisition' | 'input' | 'output'
}

export interface VersionLineageGraph {
  rootVersionId: string
  direction: 'upstream' | 'downstream' | 'both'
  nodes: VersionGraphNode[]
  edges: VersionGraphEdge[]
  truncated: boolean
}

export interface StorageLocationDetail {
  id: string
  uri: string
  storageKind: string
  storageSystemKey: string | null
  region: string | null
  bucket: string | null
  status: 'available' | 'archived' | 'missing' | 'deleted' | 'unknown'
  isPrimary: boolean
  observedAt: string
  madoConnectionId: string | null
  metadata: Record<string, unknown>
}

export interface DatasetVersionDetail {
  id: string
  datasetId: string
  version: string
  contentHash: string | null
  manifestUri: string | null
  manifestHash: string | null
  schemaUri: string | null
  createdAt: string
  metadata: Record<string, unknown>
  locations: StorageLocationDetail[]
}

export interface DatasetDetail extends RegistryDatasetSummary {
  createdAt: string
  versions: DatasetVersionDetail[]
}

export interface LineageRunDatasetRef {
  versionId: string
  version: string
  namespace: string
  name: string
  primaryUri: string | null
  storageKind: string | null
}

export interface LineageRunDetail {
  id: string
  runKey: string
  jobNamespace: string
  jobName: string
  status: 'RUNNING' | 'COMPLETE' | 'FAIL' | 'ABORT'
  startedAt: string
  endedAt: string | null
  gitSha: string | null
  containerDigest: string | null
  configUri: string | null
  configHash: string | null
  modelRefs: Record<string, unknown>[]
  runtime: Record<string, unknown>
  metrics: Record<string, unknown>
  errorMessage: string | null
  inputs: LineageRunDatasetRef[]
  outputs: LineageRunDatasetRef[]
  sources: Array<Record<string, unknown>>
}

export interface LineageSearchResult {
  id: string
  kind: LineageNodeKind
  namespace: string
  name: string
  label: string
  displayName: string | null
  description: string | null
  mediaType: string | null
  owner: string | null
  currentVersionId: string | null
  versionCount: number
  updatedAt: string | null
  datasetId: string | null
}

export interface LineageSearchResponse {
  results: LineageSearchResult[]
  totalCount: number
  warnings: string[]
}

export interface OpenLineageIngestResult {
  accepted: true
  duplicate: boolean
  eventId: string
  runId: string
  projection: 'pending' | 'published'
  warnings: string[]
}
