import { describe, expect, it, vi } from 'vitest'
import { createMarquezClient, marquezNodeId } from './marquez-client.js'

describe('Marquez 読み取り client', () => {
  it('structured identityからnodeIdを作り、GET以外を持たない', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      JSON.stringify({ graph: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = createMarquezClient({ baseUrl: 'http://marquez:5000', fetch })
    await client.getGraph({ kind: 'dataset', namespace: 'speech:jp', name: 'raw/audio' }, 4)

    const [rawUrl, init] = fetch.mock.calls[0]
    const url = new URL(String(rawUrl))
    expect(url.pathname).toBe('/api/v1/lineage')
    expect(url.searchParams.get('nodeId')).toBe('dataset:speech:jp:raw/audio')
    expect(url.searchParams.get('depth')).toBe('4')
    expect(init?.method).toBe('GET')
    expect('ingestOpenLineage' in client).toBe(false)
  })

  it('node IDはopaqueな文字列として生成する', () => {
    expect(marquezNodeId('job', 'a:b', 'c:d')).toBe('job:a:b:c:d')
  })

  it('404をサービス停止ではなく未投影として区別する', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      JSON.stringify({ code: 404, message: 'Dataset not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    ))
    const client = createMarquezClient({ baseUrl: 'http://marquez:5000', fetch })

    await expect(client.getGraph(
      { kind: 'dataset', namespace: 'speech', name: 'unconnected' }, 3,
    )).rejects.toMatchObject({ code: 'not_found' })
  })
})
