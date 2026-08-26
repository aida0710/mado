import { describe, expect, it, vi } from 'vitest'
import type { MarquezClient } from './marquez-client.js'
import type { RegistryClient } from './registry-client.js'
import { createLineageService } from './lineage-service.js'

function registry(overrides: Partial<RegistryClient> = {}): RegistryClient {
  return {
    ingestOpenLineage: vi.fn(),
    resolveDatasets: vi.fn().mockResolvedValue([]),
    searchDatasets: vi.fn().mockResolvedValue({ results: [], totalCount: 0 }),
    resolveStorageLocation: vi.fn().mockResolvedValue({ uri: '', matches: [], totalCount: 0 }),
    getDataset: vi.fn(), getVersion: vi.fn(), getRun: vi.fn(), getVersionGraph: vi.fn(),
    getProjectionStatus: vi.fn().mockResolvedValue({
      state: 'synced', pendingEvents: 0, oldestPendingAt: null,
    }),
    ...overrides,
  }
}

function marquez(overrides: Partial<MarquezClient> = {}): MarquezClient {
  return {
    getGraph: vi.fn().mockResolvedValue({ graph: [] }),
    search: vi.fn().mockResolvedValue({ results: [], totalCount: 0 }),
    getJobRuns: vi.fn().mockResolvedValue({ runs: [] }),
    ...overrides,
  }
}

describe('lineage service', () => {
  it('Marquez topologyへRegistry dataset詳細を付加しedgeを重複排除する', async () => {
    const ds = 'dataset:speech:raw'
    const job = 'job:speech:curate'
    const reg = registry({
      resolveDatasets: vi.fn().mockResolvedValue([{
        kind: 'dataset', datasetId: 'd1', datasetKey: 'raw', namespace: 'speech', name: 'raw',
        displayName: 'Raw speech', aliases: [],
        description: null, mediaType: 'audio', owner: null, currentVersionId: 'v1', versionCount: 1,
      }]),
    })
    const marq = marquez({
      getGraph: vi.fn().mockResolvedValue({ graph: [
        {
          id: ds, type: 'DATASET', data: { id: { namespace: 'speech', name: 'raw' } },
          inEdges: [], outEdges: [{ origin: ds, destination: job }],
        },
        {
          id: job, type: 'JOB', data: { id: { namespace: 'speech', name: 'curate' } },
          inEdges: [{ origin: ds, destination: job }], outEdges: [],
        },
      ] }),
    })

    const graph = await createLineageService({ registry: reg, marquez: marq }).logicalGraph({
      kind: 'dataset', namespace: 'speech', name: 'raw', depth: 3,
    })
    expect(graph.nodes.find(node => node.id === ds)?.registry?.datasetId).toBe('d1')
    expect(graph.edges).toEqual([{ id: `${ds}->${job}`, source: ds, target: job, kind: 'input' }])
    expect(graph.projection.state).toBe('synced')
  })

  it('Marquez停止時もrootとprojection警告を返す', async () => {
    const service = createLineageService({
      registry: registry(),
      marquez: marquez({ getGraph: vi.fn().mockRejectedValue(new Error('offline')) }),
    })
    const graph = await service.logicalGraph({
      kind: 'dataset', namespace: 'speech', name: 'raw', depth: 3,
    })
    expect(graph.nodes).toHaveLength(1)
    expect(graph.projection.state).toBe('unavailable')
    expect(graph.warnings[0]).toContain('Marquez')
  })

  it('Registry検索とMarquez検索を統合しRegistryのdataset IDを優先する', async () => {
    const service = createLineageService({
      registry: registry({
        searchDatasets: vi.fn().mockResolvedValue({ results: [{
          kind: 'dataset', datasetId: 'd1', datasetKey: 'raw', namespace: 'speech', name: 'raw',
          displayName: 'Raw speech', aliases: [],
          description: null, mediaType: null, owner: null, currentVersionId: null, versionCount: 0,
        }], totalCount: 1 }),
      }),
      marquez: marquez({
        search: vi.fn().mockResolvedValue({ results: [{
          type: 'DATASET', namespace: 'speech', name: 'raw',
          nodeId: 'dataset:speech:raw', updatedAt: '2026-08-26T00:00:00Z',
        }], totalCount: 1 }),
      }),
    })
    const result = await service.search({ q: 'raw', limit: 10 })
    expect(result.results).toHaveLength(1)
    expect(result.results[0].datasetId).toBe('d1')
  })

  it('StorageSystem bindingをVersion locationへ付加する', async () => {
    const reg = registry({
      getVersion: vi.fn().mockResolvedValue({
        id: 'v1', datasetId: 'd1', version: '1', contentHash: null,
        manifestUri: null, manifestHash: null, schemaUri: null,
        createdAt: '2026-08-26T00:00:00Z', metadata: {},
        locations: [{
          id: 'l1', uri: 's3://raw/a', storageKind: 's3', storageSystemKey: 'mdx-s3',
          region: null, bucket: 'raw', status: 'available', isPrimary: true,
          observedAt: '2026-08-26T00:00:00Z', madoConnectionId: null, metadata: {},
        }],
      }),
    })
    const service = createLineageService({
      registry: reg,
      marquez: marquez(),
      bindings: {
        resolve: vi.fn().mockResolvedValue(new Map([['mdx-s3', 'conn123456']])),
        keyForConnection: vi.fn().mockResolvedValue('mdx-s3'),
      },
    })
    expect((await service.version('v1')).locations[0].madoConnectionId).toBe('conn123456')
  })

  it('Mado接続とS3 pathを登録済みDataset Versionへ逆引きする', async () => {
    const match = {
      kind: 'dataset' as const, datasetId: 'd1', datasetKey: 'raw',
      namespace: 'speech', name: 'raw', displayName: 'Raw speech', aliases: [],
      description: null, mediaType: 'audio', owner: null, currentVersionId: 'v1', versionCount: 1,
      versionId: 'v1', version: '1', versionCreatedAt: '2026-08-26T00:00:00Z',
      locationId: 'l1', locationUri: 's3://dataset/raw/', status: 'available' as const,
      isPrimary: true, observedAt: '2026-08-26T00:00:00Z', matchType: 'prefix' as const,
    }
    const reg = registry({
      resolveStorageLocation: vi.fn().mockResolvedValue({
        uri: 's3://dataset/raw/part/a.tar', matches: [match], totalCount: 1,
      }),
    })
    const service = createLineageService({
      registry: reg,
      marquez: marquez(),
      bindings: {
        resolve: vi.fn().mockResolvedValue(new Map()),
        keyForConnection: vi.fn().mockResolvedValue('mdx-s3'),
      },
    })

    const result = await service.resolveLocation({
      connectionId: 'conn123456', bucket: 'dataset', key: '/raw/part/a.tar', limit: 20,
    })

    expect(result.matches[0].versionId).toBe('v1')
    expect(reg.resolveStorageLocation).toHaveBeenCalledWith(
      'mdx-s3', 's3://dataset/raw/part/a.tar', 20,
    )
  })
})
