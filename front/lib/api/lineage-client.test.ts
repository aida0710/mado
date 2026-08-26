import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('lineage api client', () => {
  it('encodes a unified graph query without parsing opaque values', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      nodes: [], edges: [], projection: { state: 'synced', pendingEvents: 0, oldestPendingAt: null },
      generatedAt: '2026-08-26T00:00:00Z', truncated: false, warnings: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.lineageGraph({
      mode: 'versions', versionId: 'opaque/a:b', namespace: 'ignored?', depth: 4,
    })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/internal/lineage/graph?')
    expect(new URL(url, 'http://mado').searchParams.get('versionId')).toBe('opaque/a:b')
    expect(new URL(url, 'http://mado').searchParams.get('mode')).toBe('versions')
  })

  it('encodes detail IDs as a single path segment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'v/a:b', datasetId: 'd', version: 'v1', contentHash: null, manifestUri: null,
      manifestHash: null, schemaUri: null, createdAt: '2026-08-26T00:00:00Z', metadata: {}, locations: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    await api.lineageVersion('v/a:b')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/internal/lineage/versions/v%2Fa%3Ab')
  })

  it('登録一覧とStorage逆引きqueryをencodeする', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [], totalCount: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        storageSystemKey: null, uri: 's3://dataset/a b/', matches: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.lineageCatalog({ q: 'Podcast 対話', limit: 20, offset: 40 })
    await api.lineageResolveLocation('conn/1', 'dataset', 'a b/')

    const catalog = new URL(String(fetchMock.mock.calls[0][0]), 'http://mado')
    expect(catalog.searchParams.get('q')).toBe('Podcast 対話')
    expect(catalog.searchParams.get('offset')).toBe('40')
    const location = new URL(String(fetchMock.mock.calls[1][0]), 'http://mado')
    expect(location.searchParams.get('connectionId')).toBe('conn/1')
    expect(location.searchParams.get('key')).toBe('a b/')
  })
})
