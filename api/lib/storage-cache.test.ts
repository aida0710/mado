import { describe, expect, it } from 'vitest'
import { cacheKey, LIST_CACHE_TTL_MS } from './storage-cache.js'

describe('cacheKey', () => {
  it('同じスコープからは同じキーが出る', () => {
    const a = cacheKey({ kind: 'list', connId: 'c1', bucket: 'b', prefix: 'p/' })
    const b = cacheKey({ kind: 'list', connId: 'c1', bucket: 'b', prefix: 'p/' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('kind / connId / bucket / prefix / recursive / cursor のどれが違ってもキーが変わる', () => {
    const base = { kind: 'list' as const, connId: 'c1', bucket: 'b', prefix: 'p/' }
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, kind: 'buckets' }),
      cacheKey({ ...base, connId: 'c2' }),
      cacheKey({ ...base, bucket: 'b2' }),
      cacheKey({ ...base, prefix: 'q/' }),
      cacheKey({ ...base, recursive: true }),
      cacheKey({ ...base, continuation: 'tok' }),
      cacheKey({ ...base, startAfter: 'k' }),
    ])
    expect(keys.size).toBe(8)
  })

  it('省略可能な項目は未指定と空文字を同じ扱いにする', () => {
    expect(cacheKey({ kind: 'buckets', connId: 'c1' }))
      .toBe(cacheKey({ kind: 'buckets', connId: 'c1', bucket: '', prefix: '' }))
  })

  it('TTL は 24 時間', () => {
    expect(LIST_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
