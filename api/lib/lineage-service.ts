import type {
  DatasetDetail,
  DatasetVersionDetail,
  LineageProjectionStatus,
  LineageRunDetail,
  LineageSearchResponse,
  LogicalLineageEdge,
  LogicalLineageGraph,
  LogicalLineageNode,
  RegistryDatasetSummary,
  VersionLineageGraph,
} from '../shared/lineage-types.js'
import type { MarquezClient, MarquezGraphNode } from './marquez-client.js'
import { marquezNodeId } from './marquez-client.js'
import type { RegistryClient } from './registry-client.js'

export interface LogicalGraphQuery {
  kind: 'dataset' | 'job'
  namespace: string
  name: string
  depth: number
}

export interface VersionGraphQuery {
  versionId: string
  direction: 'upstream' | 'downstream' | 'both'
  depth: number
}

export interface LineageService {
  logicalGraph(query: LogicalGraphQuery): Promise<LogicalLineageGraph>
  versionGraph(query: VersionGraphQuery): Promise<VersionLineageGraph>
  search(query: { q: string; namespace?: string; limit: number }): Promise<LineageSearchResponse>
  dataset(id: string): Promise<DatasetDetail>
  version(id: string): Promise<DatasetVersionDetail>
  run(id: string): Promise<LineageRunDetail>
  jobRuns(namespace: string, name: string, limit: number): Promise<Record<string, unknown>>
  projectionStatus(): Promise<LineageProjectionStatus>
}

/** Mado DBのlineage_storage_bindingsを読むadapter。 */
export interface StorageBindingResolver {
  resolve(storageSystemKeys: readonly string[]): Promise<ReadonlyMap<string, string>>
}

function nodeIdentity(node: MarquezGraphNode): { namespace: string; name: string } | null {
  const namespace = node.data.id?.namespace ?? node.data.namespace
  const name = node.data.id?.name ?? node.data.name
  return typeof namespace === 'string' && namespace.length > 0
    && typeof name === 'string' && name.length > 0
    ? { namespace, name }
    : null
}

function edgeKind(
  source: string,
  target: string,
  kinds: ReadonlyMap<string, 'JOB' | 'DATASET'>,
): LogicalLineageEdge['kind'] {
  if (kinds.get(source) === 'DATASET' && kinds.get(target) === 'JOB') return 'input'
  if (kinds.get(source) === 'JOB' && kinds.get(target) === 'DATASET') return 'output'
  return 'lineage'
}

function unavailableProjection(message: string): LineageProjectionStatus {
  return {
    state: 'unavailable',
    pendingEvents: null,
    oldestPendingAt: null,
    message,
  }
}

function registryKey(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`
}

export function createLineageService(deps: {
  registry: RegistryClient
  marquez: MarquezClient
  bindings?: StorageBindingResolver
}): LineageService {
  const projectionStatus = async (): Promise<LineageProjectionStatus> => {
    try {
      return await deps.registry.getProjectionStatus()
    } catch {
      return unavailableProjection('Registry projection status is unavailable')
    }
  }

  const logicalGraph = async (query: LogicalGraphQuery): Promise<LogicalLineageGraph> => {
    const warnings: string[] = []
    const root = {
      kind: query.kind,
      namespace: query.namespace,
      name: query.name,
      nodeId: marquezNodeId(query.kind, query.namespace, query.name),
    } as const

    const projectionPromise = projectionStatus()
    let rawNodes: MarquezGraphNode[]
    try {
      rawNodes = (await deps.marquez.getGraph(query, query.depth)).graph
    } catch {
      warnings.push('Marquez lineage projection is unavailable')
      let rootRegistry: RegistryDatasetSummary | null = null
      if (query.kind === 'dataset') {
        try {
          rootRegistry = (await deps.registry.resolveDatasets([
            { namespace: query.namespace, name: query.name },
          ]))[0] ?? null
        } catch {
          warnings.push('Registry dataset enrichment is unavailable')
        }
      }
      return {
        root,
        nodes: [{
          id: root.nodeId,
          kind: rootRegistry?.kind ?? query.kind,
          namespace: query.namespace,
          name: query.name,
          label: query.name,
          updatedAt: null,
          completeness: rootRegistry ? 'complete' : 'unregistered',
          registry: rootRegistry,
          latestRun: null,
        }],
        edges: [],
        projection: unavailableProjection('Marquez lineage projection is unavailable'),
        warnings,
      }
    }

    const identities = rawNodes
      .filter(node => node.type === 'DATASET')
      .map(nodeIdentity)
      .filter((value): value is { namespace: string; name: string } => value !== null)

    let resolved: RegistryDatasetSummary[] = []
    try {
      resolved = await deps.registry.resolveDatasets(identities)
    } catch {
      warnings.push('Registry dataset enrichment is unavailable')
    }
    const registryByIdentity = new Map(
      resolved.map(item => [registryKey(item.namespace, item.name), item]),
    )
    const kinds = new Map(rawNodes.map(node => [node.id, node.type]))
    const nodes: LogicalLineageNode[] = []

    for (const node of rawNodes) {
      const identity = nodeIdentity(node)
      if (!identity) {
        warnings.push(`Skipped malformed Marquez node: ${node.id}`)
        continue
      }
      const registry = node.type === 'DATASET'
        ? registryByIdentity.get(registryKey(identity.namespace, identity.name)) ?? null
        : null
      const latest = node.data.latestRun
      nodes.push({
        id: node.id,
        kind: registry?.kind ?? (node.type === 'JOB' ? 'job' : 'dataset'),
        namespace: identity.namespace,
        name: identity.name,
        label: identity.name,
        updatedAt: typeof node.data.updatedAt === 'string' ? node.data.updatedAt : null,
        completeness: node.type === 'JOB' ? 'partial' : registry ? 'complete' : 'unregistered',
        registry,
        latestRun: latest ? {
          id: typeof latest.id === 'string' ? latest.id : null,
          state: typeof latest.state === 'string' ? latest.state : null,
          startedAt: typeof latest.startedAt === 'string' ? latest.startedAt : null,
          endedAt: typeof latest.endedAt === 'string' ? latest.endedAt : null,
        } : null,
      })
    }

    const edgesById = new Map<string, LogicalLineageEdge>()
    for (const node of rawNodes) {
      for (const edge of [...(node.inEdges ?? []), ...(node.outEdges ?? [])]) {
        const id = `${edge.origin}->${edge.destination}`
        edgesById.set(id, {
          id,
          source: edge.origin,
          target: edge.destination,
          kind: edgeKind(edge.origin, edge.destination, kinds),
        })
      }
    }

    return {
      root,
      nodes,
      edges: [...edgesById.values()],
      projection: await projectionPromise,
      warnings,
    }
  }

  const search = async (
    query: { q: string; namespace?: string; limit: number },
  ): Promise<LineageSearchResponse> => {
    const warnings: string[] = []
    const [registryResult, marquezResult] = await Promise.allSettled([
      deps.registry.searchDatasets(query),
      deps.marquez.search(query),
    ])
    if (registryResult.status === 'rejected') warnings.push('Registry search is unavailable')
    if (marquezResult.status === 'rejected') warnings.push('Marquez search is unavailable')

    const byId = new Map<string, LineageSearchResponse['results'][number]>()
    if (marquezResult.status === 'fulfilled') {
      for (const item of marquezResult.value.results) {
        byId.set(item.nodeId, {
          id: item.nodeId,
          kind: item.type === 'JOB' ? 'job' : 'dataset',
          namespace: item.namespace,
          name: item.name,
          label: item.name,
          updatedAt: item.updatedAt,
          datasetId: null,
        })
      }
    }
    if (registryResult.status === 'fulfilled') {
      for (const item of registryResult.value.results) {
        const id = marquezNodeId('dataset', item.namespace, item.name)
        byId.set(id, {
          id,
          kind: item.kind,
          namespace: item.namespace,
          name: item.name,
          label: item.name,
          updatedAt: null,
          datasetId: item.datasetId,
        })
      }
    }
    const results = [...byId.values()].slice(0, query.limit)
    return { results, totalCount: results.length, warnings }
  }

  const bindVersionLocations = async (
    version: DatasetVersionDetail,
  ): Promise<DatasetVersionDetail> => {
    if (!deps.bindings) return version
    const keys = [...new Set(version.locations
      .map(location => location.storageSystemKey)
      .filter((key): key is string => key !== null))]
    if (keys.length === 0) return version
    const bindings = await deps.bindings.resolve(keys)
    return {
      ...version,
      locations: version.locations.map(location => ({
        ...location,
        madoConnectionId: location.storageSystemKey
          ? bindings.get(location.storageSystemKey) ?? null
          : null,
      })),
    }
  }

  const dataset = async (id: string): Promise<DatasetDetail> => {
    const detail = await deps.registry.getDataset(id)
    return {
      ...detail,
      versions: await Promise.all(detail.versions.map(bindVersionLocations)),
    }
  }

  return {
    logicalGraph,
    versionGraph: query => deps.registry.getVersionGraph(
      query.versionId, query.direction, query.depth,
    ),
    search,
    dataset,
    version: async id => bindVersionLocations(await deps.registry.getVersion(id)),
    run: id => deps.registry.getRun(id),
    jobRuns: (namespace, name, limit) => deps.marquez.getJobRuns(namespace, name, limit),
    projectionStatus,
  }
}
