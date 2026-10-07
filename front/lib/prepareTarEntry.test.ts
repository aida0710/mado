import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareTarEntry } from './prepareTarEntry'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('tar本文の準備', () => {
  it('索引が準備中ならHEADだけで再開し、準備が済んだら返す', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(null, { status: 202, headers: { 'X-Tar-Index-Pending': '1', 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    const controller = new AbortController()
    const prepared = prepareTarEntry('/entry', controller.signal)
    await vi.advanceTimersByTimeAsync(1000)
    await prepared
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === 'HEAD')).toBe(true)
  })

  it('画面を閉じたら再試行を止める', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202, headers: { 'X-Tar-Index-Pending': '1' } }))
    const controller = new AbortController()
    const prepared = prepareTarEntry('/entry', controller.signal)
    const failed = expect(prepared).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await failed
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('本文の不存在や上限エラーは再試行せず表示へ渡す', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'entry not found' }), { status: 404 }))
    await expect(prepareTarEntry('/entry', new AbortController().signal)).rejects.toThrow('entry not found')
    expect(fetch).toHaveBeenCalledOnce()
  })
})
