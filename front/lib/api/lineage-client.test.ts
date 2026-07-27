import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

const okJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('lineage links client', () => {
  it('lineageLinks: URL を組み立てて zod でパースする', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson([
      { id: 1, parentBucket: 'raw', parentPath: '2024-01/', childBucket: 'clean', childPath: 'v2/', createdBy: 'aida', createdAt: '2026-07-24T00:00:00Z' },
    ]))
    const r = await api.lineageLinks('c 1')
    expect(r).toHaveLength(1)
    expect(r[0].parentBucket).toBe('raw')
    expect(String(spy.mock.calls[0][0])).toBe('/api/internal/storage/c%201/lineage-links')
  })

  it('addLineageLink: body を POST し、返ってきた id を返す', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ ok: true, id: 42 }))
    const id = await api.addLineageLink(
      'lc', { bucket: 'raw', path: '2024-01/' }, { bucket: 'clean', path: 'v2/' }, 'aida',
    )
    expect(id).toBe(42)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/lc/lineage-links')
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      parent: { bucket: 'raw', path: '2024-01/' },
      child: { bucket: 'clean', path: 'v2/' },
      editor: 'aida',
    })
  })

  it('removeLineageLink: DELETE を id 付きで叩く', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ ok: true }))
    await api.removeLineageLink('rc', 42)
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).toBe('/api/internal/storage/rc/lineage-links/42')
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('lineageLinks はキャッシュされ、addLineageLink 後に再取得される', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okJson([]))
      .mockResolvedValueOnce(okJson({ ok: true, id: 1 }))
      .mockResolvedValueOnce(okJson([{ id: 1, parentBucket: 'a', parentPath: '', childBucket: 'b', childPath: '', createdBy: 'x', createdAt: '2026-01-01T00:00:00Z' }]))

    await api.lineageLinks('cache-test')
    await api.lineageLinks('cache-test') // キャッシュヒットなので fetch は増えない
    expect(spy).toHaveBeenCalledTimes(1)

    await api.addLineageLink('cache-test', { bucket: 'a', path: '' }, { bucket: 'b', path: '' }, 'x')
    const r = await api.lineageLinks('cache-test') // invalidate 済みなので再取得
    expect(spy).toHaveBeenCalledTimes(3)
    expect(r).toHaveLength(1)
  })
})
