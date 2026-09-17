import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
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
