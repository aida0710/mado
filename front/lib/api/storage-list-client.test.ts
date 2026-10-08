import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'
import { clearAllCaches } from './cache'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearAllCaches()
})

describe('バケット一覧cacheの取得時刻', () => {
  it('サーバーから古い一覧を受け取ってもS3取得時刻を現在に変えない', async () => {
    const fetchedAt = '2026-10-07T00:00:00.000Z'
    const responseBody = {
      buckets: [{ name: 'old-bucket', creationDate: null }],
      cache: { fetchedAt, expiresAt: '2099-10-08T00:00:00.000Z', hit: true },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(responseBody))))

    await api.buckets('buckets-cache-meta-test')
    expect(api.lastFetched.buckets('buckets-cache-meta-test')?.toISOString()).toBe(fetchedAt)
  })

  it('サーバーの有効期限が来たらブラウザの6時間を待たずに取り直す', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-10-08T00:00:00.000Z')
    vi.setSystemTime(now)
    const fetchBuckets = vi.fn(async () => new Response(JSON.stringify({
      buckets: [{ name: 'bucket', creationDate: null }],
      cache: { fetchedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 1000).toISOString(), hit: true },
    })))
    vi.stubGlobal('fetch', fetchBuckets)

    await api.buckets('buckets-expiry-test')
    vi.advanceTimersByTime(1001)
    await api.buckets('buckets-expiry-test')
    expect(fetchBuckets).toHaveBeenCalledTimes(2)
  })

  it('取得時刻が不明な旧形式の永続キャッシュは再取得する', async () => {
    localStorage.setItem('mado.cache.buckets:buckets|buckets-legacy-test', JSON.stringify({
      value: { buckets: [{ name: 'old-bucket', creationDate: null }] },
      expiresAt: Date.now() + 60_000,
    }))
    const fetchBuckets = vi.fn(async () => new Response(JSON.stringify({
      buckets: [{ name: 'new-bucket', creationDate: null }],
      cache: { fetchedAt: '2026-10-08T00:00:00.000Z', expiresAt: '2099-10-08T00:00:00.000Z', hit: false },
    })))
    vi.stubGlobal('fetch', fetchBuckets)
    vi.resetModules()
    const { storageListClient } = await import('./storage-list-client')

    expect((await storageListClient.buckets('buckets-legacy-test')).buckets[0].name).toBe('new-bucket')
    expect(fetchBuckets).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('mado.cache.buckets:buckets|buckets-legacy-test')).toBeNull()
  })
})

describe('一覧 cache の取得時刻', () => {
  it('APIを受け取った時刻ではなくS3取得時刻をlastFetchedへ使う', async () => {
    const fetchedAt = '2026-09-15T01:23:45.000Z'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      directories: ['old/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
      cache: {
        fetchedAt,
        expiresAt: '2099-09-16T01:23:45.000Z',
        hit: true,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await api.list({ connectionId: 'cache-meta-test', bucket: 'bucket', prefix: 'prefix/' })

    expect(api.lastFetched.list({ connectionId: 'cache-meta-test', bucket: 'bucket', prefix: 'prefix/' })?.toISOString())
      .toBe(fetchedAt)
  })
})
