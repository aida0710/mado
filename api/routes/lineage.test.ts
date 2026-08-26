import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { LineageService } from '../lib/lineage-service.js'
import { mountLineageRoutes } from './lineage.js'

function service(overrides: Partial<LineageService> = {}): LineageService {
  return {
    logicalGraph: vi.fn().mockResolvedValue({
      root: { kind: 'dataset', namespace: 'speech', name: 'raw', nodeId: 'dataset:speech:raw' },
      nodes: [], edges: [],
      projection: { state: 'synced', pendingEvents: 0, oldestPendingAt: null }, warnings: [],
    }),
    versionGraph: vi.fn().mockResolvedValue({
      rootVersionId: '32c6440d-57e6-435d-bda4-bf2eb6a666eb', direction: 'both',
      nodes: [], edges: [], truncated: false,
    }),
    search: vi.fn().mockResolvedValue({ results: [], totalCount: 0, warnings: [] }),
    catalog: vi.fn().mockResolvedValue({ results: [], totalCount: 0 }),
    resolveLocation: vi.fn().mockResolvedValue({ storageSystemKey: null, uri: '', matches: [] }),
    dataset: vi.fn(), version: vi.fn(), run: vi.fn(), jobRuns: vi.fn(),
    projectionStatus: vi.fn().mockResolvedValue({
      state: 'synced', pendingEvents: 0, oldestPendingAt: null,
    }),
    ...overrides,
  }
}

describe('lineage read routes', () => {
  it('logical graph queryを検証しdepthをclampする', async () => {
    const svc = service()
    const app = new Hono()
    mountLineageRoutes(app, { service: svc })
    const res = await app.request(
      '/lineage/graph?mode=logical&rootKind=dataset&namespace=speech%3Ajp&name=raw%2Faudio&depth=999',
    )
    expect(res.status).toBe(200)
    expect(svc.logicalGraph).toHaveBeenCalledWith({
      kind: 'dataset', namespace: 'speech:jp', name: 'raw/audio', depth: 10,
    })
  })

  it('versions modeを同じgraph endpointでdispatchする', async () => {
    const svc = service()
    const app = new Hono()
    mountLineageRoutes(app, { service: svc })
    const id = '32c6440d-57e6-435d-bda4-bf2eb6a666eb'
    const res = await app.request(`/lineage/graph?mode=versions&versionId=${id}&direction=upstream`)
    expect(res.status).toBe(200)
    expect(svc.versionGraph).toHaveBeenCalledWith({
      versionId: id, direction: 'upstream', depth: 3,
    })
  })

  it('不正なmodeとIDを400にする', async () => {
    const app = new Hono()
    mountLineageRoutes(app, { service: service() })
    expect((await app.request('/lineage/graph?mode=nope')).status).toBe(400)
    expect((await app.request('/lineage/versions/not-a-uuid')).status).toBe(400)
  })

  it('search limitを100にclampする', async () => {
    const svc = service()
    const app = new Hono()
    mountLineageRoutes(app, { service: svc })
    await app.request('/lineage/search?q=raw&limit=10000')
    expect(svc.search).toHaveBeenCalledWith({ q: 'raw', namespace: undefined, limit: 100 })
  })

  it('登録一覧をpagingしStorage pathを逆引きする', async () => {
    const svc = service()
    const app = new Hono()
    mountLineageRoutes(app, { service: svc })

    expect((await app.request('/lineage/catalog?q=podcast&limit=20&offset=40')).status).toBe(200)
    expect(svc.catalog).toHaveBeenCalledWith({
      q: 'podcast', namespace: undefined, limit: 20, offset: 40,
    })

    expect((await app.request(
      '/lineage/resolve-location?connectionId=conn1&bucket=dataset&key=podcast%2Fa.tar',
    )).status).toBe(200)
    expect(svc.resolveLocation).toHaveBeenCalledWith({
      connectionId: 'conn1', bucket: 'dataset', key: 'podcast/a.tar', limit: 20,
    })
  })
})
