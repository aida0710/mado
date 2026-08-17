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

  describe('stale-while-revalidate (onRevalidate)', () => {
    it('期限切れでも stale を即返し、裏で loader を走らせる', async () => {
      const cache = new TTLCache<number>(1_000)
      let n = 0
      const loader = vi.fn(async () => ++n)
      expect(await cache.get('k', loader)).toBe(1)
      vi.advanceTimersByTime(1_500)

      const fresh: Promise<number>[] = []
      expect(await cache.get('k', loader, p => fresh.push(p))).toBe(1) // stale が即返る
      expect(loader).toHaveBeenCalledTimes(2)                          // 裏では走っている
      expect(await fresh[0]).toBe(2)
      expect(await cache.get('k', loader)).toBe(2)                     // 入れ替わり済み
      expect(loader).toHaveBeenCalledTimes(2)
    })

    it('revalidate 中は取得時刻を据え置き、完了時に新しくする', async () => {
      const t0 = new Date('2026-05-15T10:00:00Z').getTime()
      const t1 = new Date('2026-05-15T10:05:00Z').getTime()
      vi.setSystemTime(t0)
      const cache = new TTLCache<number>(1_000)
      await cache.get('k', async () => 1)
      expect(cache.getFetchedAt('k')).toBe(t0)

      vi.setSystemTime(t1)
      let resolve!: (v: number) => void
      const fresh: Promise<number>[] = []
      const stale = await cache.get('k', () => new Promise<number>(r => { resolve = r }), p => fresh.push(p))
      expect(stale).toBe(1)
      expect(cache.getFetchedAt('k')).toBe(t0) // まだ古いまま = UI に出す「キャッシュ日時」
      resolve(2)
      await fresh[0]
      expect(cache.getFetchedAt('k')).toBe(t1)
    })

    it('revalidate が失敗しても stale は残り、次回また再試行する', async () => {
      const cache = new TTLCache<number>(1_000)
      await cache.get('k', async () => 1)
      vi.advanceTimersByTime(1_500)

      const failed: Promise<number>[] = []
      const failing = vi.fn().mockRejectedValue(new Error('boom'))
      expect(await cache.get('k', failing, p => failed.push(p))).toBe(1)
      await expect(failed[0]).rejects.toThrow('boom')

      const retry = vi.fn(async () => 2)
      expect(await cache.get('k', retry, () => {})).toBe(1) // stale が生きている
      expect(retry).toHaveBeenCalledTimes(1)                 // 再試行もしている
    })

    it('revalidate 中の同一キー呼び出しは loader を再実行しない', async () => {
      const cache = new TTLCache<number>(1_000)
      await cache.get('k', async () => 1)
      vi.advanceTimersByTime(1_500)
      const loader = vi.fn(() => new Promise<number>(() => {})) // 解決しない
      await cache.get('k', loader, () => {})
      await cache.get('k', loader, () => {})
      expect(loader).toHaveBeenCalledTimes(1)
    })

    // アップロード/削除の直後に、それ以前に始まった再取得が遅れて着弾すると
    // 「invalidate したのに古い一覧が復活する」ので、着弾時に自分のエントリか確認する。
    it('revalidate 中に invalidate されたら着弾した結果を捨てる', async () => {
      const cache = new TTLCache<number>(1_000)
      await cache.get('k', async () => 1)
      vi.advanceTimersByTime(1_500)

      let resolveStale!: (v: number) => void
      const fresh: Promise<number>[] = []
      await cache.get('k', () => new Promise<number>(r => { resolveStale = r }), p => fresh.push(p))
      cache.invalidate('k')
      resolveStale(2)
      await fresh[0]

      const after = vi.fn(async () => 3)
      expect(await cache.get('k', after)).toBe(3) // 2 で復活していない
      expect(after).toHaveBeenCalledTimes(1)
    })

    it('blocking fetch 中に invalidate されても着弾した結果を捨てる', async () => {
      const cache = new TTLCache<number>(1_000)
      let resolveFirst!: (v: number) => void
      const first = cache.get('k', () => new Promise<number>(r => { resolveFirst = r }))
      cache.invalidate('k')
      resolveFirst(1)
      expect(await first).toBe(1) // 呼び出し元には返る

      const after = vi.fn(async () => 2)
      expect(await cache.get('k', after)).toBe(2) // キャッシュには残っていない
    })

    it('onRevalidate 無しなら従来通り blocking で再取得する', async () => {
      const cache = new TTLCache<number>(1_000)
      let n = 0
      const loader = vi.fn(async () => ++n)
      await cache.get('k', loader)
      vi.advanceTimersByTime(1_500)
      expect(await cache.get('k', loader)).toBe(2) // stale ではなく新しい値
    })
  })

  describe('localStorage 永続化 (persistKey)', () => {
    beforeEach(() => { localStorage.clear() })

    it('persistKey を渡すと値を localStorage にも書き出す', async () => {
      vi.useRealTimers()  // localStorage の JSON 化に直近時刻を入れたいので
      const cache = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      await cache.get('k1', async () => 42)
      const raw = localStorage.getItem('mado.test:k1')
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw!) as { value: number; expiresAt: number }
      expect(parsed.value).toBe(42)
      expect(parsed.expiresAt).toBeGreaterThan(Date.now())
    })

    it('新しいインスタンス (= リロード相当) でも localStorage から hydrate される', async () => {
      vi.useRealTimers()
      const a = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      const loader = vi.fn(async () => 7)
      await a.get('k', loader)
      expect(loader).toHaveBeenCalledTimes(1)

      // 別インスタンス (= モジュール再評価のシミュレート) で同じ persistKey
      const b = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      const loader2 = vi.fn(async () => 999)
      const v = await b.get('k', loader2)
      // localStorage から復活して loader2 は呼ばれない
      expect(v).toBe(7)
      expect(loader2).not.toHaveBeenCalled()
    })

    it('TTL 切れの永続エントリは (onRevalidate 無しなら) 待って新しい値を返す', async () => {
      vi.useRealTimers()
      // 期限切れの payload を直接 localStorage に置く
      localStorage.setItem('mado.test:k', JSON.stringify({ value: 11, expiresAt: Date.now() - 1000 }))
      const cache = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      const loader = vi.fn(async () => 22)
      const v = await cache.get('k', loader)
      expect(v).toBe(22)
      expect(loader).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem('mado.test:k')).not.toBeNull()  // 新しい値で書き直し済み
    })

    it('TTL 切れの永続エントリも onRevalidate 付きなら stale として即返す (リロード相当)', async () => {
      vi.useRealTimers()
      localStorage.setItem('mado.test:k', JSON.stringify({ value: 11, expiresAt: Date.now() - 1000 }))
      const cache = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      const fresh: Promise<number>[] = []
      const loader = vi.fn(async () => 22)
      expect(await cache.get('k', loader, p => fresh.push(p))).toBe(11)
      expect(await fresh[0]).toBe(22)
      expect(await cache.get('k', loader)).toBe(22)
    })

    it('invalidate は localStorage からも削除する', async () => {
      vi.useRealTimers()
      const cache = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      await cache.get('k', async () => 5)
      expect(localStorage.getItem('mado.test:k')).not.toBeNull()
      cache.invalidate('k')
      expect(localStorage.getItem('mado.test:k')).toBeNull()
    })

    it('invalidatePrefix は localStorage の同 prefix も一括削除する', async () => {
      vi.useRealTimers()
      const cache = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      await cache.get('a/x', async () => 1)
      await cache.get('a/y', async () => 2)
      await cache.get('b/z', async () => 3)
      cache.invalidatePrefix('a/')
      expect(localStorage.getItem('mado.test:a/x')).toBeNull()
      expect(localStorage.getItem('mado.test:a/y')).toBeNull()
      expect(localStorage.getItem('mado.test:b/z')).not.toBeNull()
    })

    it('persistKey 未指定なら localStorage には書かない', async () => {
      const cache = new TTLCache<number>(60_000)
      await cache.get('k', async () => 99)
      // 何のキーも書かれていない
      const keys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k) keys.push(k)
      }
      expect(keys).toEqual([])
    })

    it('壊れた JSON は黙って捨てて fresh fetch する', async () => {
      vi.useRealTimers()
      localStorage.setItem('mado.test:k', '{not valid json')
      const cache = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      const v = await cache.get('k', async () => 33)
      expect(v).toBe(33)
    })

    it('getFetchedAt は in-memory miss でも localStorage から時刻を復元する', () => {
      vi.useRealTimers()
      const fetchedAtMs = Date.now() - 1000
      const expiresAt = fetchedAtMs + 60_000
      localStorage.setItem('mado.test:k', JSON.stringify({ value: 1, expiresAt }))
      const cache = new TTLCache<number>(60_000, { persistKey: 'mado.test' })
      // get を呼ばずに getFetchedAt だけ呼ぶ (in-memory には何もない状態)
      const at = cache.getFetchedAt('k')
      expect(at).toBe(fetchedAtMs)
    })
  })

  describe('getFetchedAt', () => {
    it('未登録のキーは null', () => {
      const cache = new TTLCache<number>(60_000)
      expect(cache.getFetchedAt('nope')).toBeNull()
    })

    it('値が確定したタイミングをエポック ms で返す', async () => {
      vi.setSystemTime(new Date('2026-05-15T10:30:00Z'))
      const cache = new TTLCache<number>(60_000)
      await cache.get('k', async () => 42)
      // get 後の "現在時刻" が fetchedAt として返る (TTL は内部の expiresAt から逆算)
      expect(cache.getFetchedAt('k')).toBe(new Date('2026-05-15T10:30:00Z').getTime())
    })

    it('in-flight (value 未確定) のときは null を返す — 取れたタイミングが確定しないので', () => {
      const cache = new TTLCache<number>(60_000)
      // 解決させずに promise だけ走らせる
      void cache.get('k', () => new Promise<number>(() => {}))
      expect(cache.getFetchedAt('k')).toBeNull()
    })

    it('invalidate 後は null', async () => {
      const cache = new TTLCache<number>(60_000)
      await cache.get('k', async () => 1)
      expect(cache.getFetchedAt('k')).not.toBeNull()
      cache.invalidate('k')
      expect(cache.getFetchedAt('k')).toBeNull()
    })
  })
})
