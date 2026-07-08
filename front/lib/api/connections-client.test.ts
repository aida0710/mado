import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

afterEach(() => vi.restoreAllMocks())

describe('connections client', () => {
  it('listConnections は isDefault を parse する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([{
      id: 'c1', name: 'n', endpoint: 'http://e', region: 'r',
      accessKeyIdMasked: 'x…y', forcePathStyle: true, listObjectsVersion: 'v2',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      isDefault: true,
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const list = await api.listConnections()
    expect(list[0].isDefault).toBe(true)
  })

  it('setDefaultConnection は PUT /connections/:id/default を叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await api.setDefaultConnection('c 1')
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/connections/c%201/default')
    expect((init as RequestInit).method).toBe('PUT')
  })
})
