import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TTLCache } from './cache'

describe('TTLCache', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('1 度目は loader を呼び、TTL 内なら 2 度目はキャッシュから返す', async () => {
    const cache = new TTLCache<number>(60_000)
    const loader = vi.fn(async () => 42)
    expect(await cache.get('k', loader)).toBe(42)
    expect(await cache.get('k', loader)).toBe(42)
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('TTL を超えたら loader を再実行する', async () => {
    const cache = new TTLCache<number>(1_000)
    let n = 0
    const loader = vi.fn(async () => ++n)
    expect(await cache.get('k', loader)).toBe(1)
    vi.advanceTimersByTime(1_500)
    expect(await cache.get('k', loader)).toBe(2)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('同じキーへの並行呼び出しは 1 回に dedup される', async () => {
    const cache = new TTLCache<number>(60_000)
    let resolveLoader!: (v: number) => void
    const loader = vi.fn(
      () => new Promise<number>(r => { resolveLoader = r }),
    )
    const a = cache.get('k', loader)
    const b = cache.get('k', loader)
    expect(loader).toHaveBeenCalledTimes(1)
    resolveLoader(7)
    expect(await a).toBe(7)
    expect(await b).toBe(7)
  })

  it('loader が reject したらキャッシュには残さない (次回再試行)', async () => {
    const cache = new TTLCache<number>(60_000)
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(99)
    await expect(cache.get('k', loader)).rejects.toThrow('boom')
    expect(await cache.get('k', loader)).toBe(99)
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('invalidate でキーを破棄できる', async () => {
    const cache = new TTLCache<number>(60_000)
    let n = 0
    const loader = vi.fn(async () => ++n)
    expect(await cache.get('k', loader)).toBe(1)
    cache.invalidate('k')
    expect(await cache.get('k', loader)).toBe(2)
  })

  it('invalidatePrefix で同 prefix のキーを一括破棄できる', async () => {
    const cache = new TTLCache<number>(60_000)
    let n = 0
    const loader = (): Promise<number> => Promise.resolve(++n)
    await cache.get('a/x', loader)
    await cache.get('a/y', loader)
    await cache.get('b/z', loader)
    cache.invalidatePrefix('a/')
    expect(cache._size()).toBe(1) // 'b/z' のみ
  })
})
