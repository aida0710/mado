import { describe, expect, it, vi } from 'vitest'
import { createPricingRefreshHandler } from './pricing-refresh-handler.js'
import { CATALOG } from '../pricing/catalog.js'
import type { JobContext } from './job-runner.js'
import type { JobProgress } from './jobs.js'
import type { CatalogSnapshot, PricingStore } from './pricing-store.js'
import type { PricingCatalog } from './pricing-types.js'

function fakeStore(): PricingStore & { saved: PricingCatalog[] } {
  const saved: PricingCatalog[] = []
  return {
    saved,
    get: (): Promise<CatalogSnapshot> =>
      Promise.resolve({ catalog: CATALOG, source: 'bundled', fetchedAt: null }),
    save: (c: PricingCatalog): Promise<void> => { saved.push(c); return Promise.resolve() },
    invalidate: (): void => {},
  }
}

function ctx(): JobContext & { progress: JobProgress[] } {
  const progress: JobProgress[] = []
  return {
    progress,
    jobId: 1,
    payload: {},
    signal: new AbortController().signal,
    setProgress: (p: JobProgress) => progress.push(p),
  }
}

/** 実際の AWS を叩かない fetch。pricing-fetch のダミーと同じ形は要らず、
 *  ハンドラの責務 (保存する / 失敗時に保存しない) だけを見る。 */
function fetchThrows(message: string): typeof fetch {
  return vi.fn(() => Promise.reject(new Error(message))) as unknown as typeof fetch
}

describe('createPricingRefreshHandler', () => {
  it('取得に失敗したらキャッシュを触らない', async () => {
    // 取得できなかったときに古い単価が消えて費用 0 になる方が、
    // 単価が 1 回分古いより危険。
    const store = fakeStore()
    const handler = createPricingRefreshHandler({
      store, fetchImpl: fetchThrows('getaddrinfo ENOTFOUND'),
    })

    await expect(handler(ctx())).rejects.toThrow(/ENOTFOUND/)
    expect(store.saved).toHaveLength(0)
  })

  it('失敗はジョブのエラーとして伝わる (握り潰さない)', async () => {
    const store = fakeStore()
    const handler = createPricingRefreshHandler({ store, fetchImpl: fetchThrows('boom') })
    await expect(handler(ctx())).rejects.toThrow('boom')
  })

  it('取得できたら保存し、メタだけ返す', async () => {
    const store = fakeStore()
    const fetched: PricingCatalog = { ...CATALOG, asOf: '2030-01-01' }
    const handler = createPricingRefreshHandler({ store })
    // fetchCatalog を通さず、保存と戻り値の形だけを確かめたいので差し替える。
    const spy = vi.spyOn(
      await import('./pricing-fetch.js'), 'fetchCatalog',
    ).mockResolvedValue(fetched)

    try {
      const result = await handler(ctx()) as { asOf: string; regions: string[] }
      expect(store.saved).toEqual([fetched])
      expect(result.asOf).toBe('2030-01-01')
      expect(result.regions).toContain('ap-northeast-1')
      // カタログ本体は jobs.result に入れない (毎回数百 KB 積み上がる)。
      expect(JSON.stringify(result).length).toBeLessThan(500)
    } finally {
      spy.mockRestore()
    }
  })

  it('進捗を分母つきで出す (走査と違って総数が分かる)', async () => {
    const store = fakeStore()
    const handler = createPricingRefreshHandler({ store })
    const spy = vi.spyOn(
      await import('./pricing-fetch.js'), 'fetchCatalog',
    ).mockImplementation(async opts => {
      opts?.onProgress?.('料金表を取得中')
      opts?.onProgress?.('ap-northeast-1 の単価を取得中')
      return CATALOG
    })

    try {
      const c = ctx()
      await handler(c)
      expect(c.progress[0]).toEqual({
        kind: 'ratio', done: 0, total: 3, label: '料金表を取得中',
      })
      expect(c.progress[1]).toMatchObject({ kind: 'ratio', done: 1, total: 3 })
    } finally {
      spy.mockRestore()
    }
  })
})
