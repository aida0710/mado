import { describe, expect, it } from 'vitest'
import { cacheKey, createResponseCache, LIST_CACHE_TTL_MS, type Queryable } from './storage-cache.js'

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

// 実 DB を使わずに SQL の呼ばれ方を検証するための fake。
// Pool は構造的にこの形に適合するので、本番では Pool をそのまま渡す。
function fakeDb(rows: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = []
  const db: Queryable = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values })
      return { rows }
    },
  }
  return { db, calls }
}

const SCOPE = { kind: 'list' as const, connId: 'c1', bucket: 'b', prefix: 'p/' }

describe('createResponseCache', () => {
  it('hit したら payload を返す', async () => {
    const { db, calls } = fakeDb([{ payload: { directories: ['p/x/'], files: [] } }])
    const cache = createResponseCache(db)
    expect(await cache.get(SCOPE)).toEqual({ directories: ['p/x/'], files: [] })
    expect(calls[0].text).toContain('expires_at > now()')
    expect(calls[0].values[0]).toBe(cacheKey(SCOPE))
  })

  it('行が無ければ null を返す (miss)', async () => {
    const { db } = fakeDb([])
    expect(await createResponseCache(db).get(SCOPE)).toBeNull()
  })

  it('set は conn_id / bucket / prefix も一緒に書き、TTL 後の期限を入れる', async () => {
    const { db, calls } = fakeDb()
    await createResponseCache(db, 1000).set(SCOPE, { ok: true })
    expect(calls[0].text).toContain('ON CONFLICT (cache_key) DO UPDATE')
    expect(calls[0].values.slice(0, 4)).toEqual([cacheKey(SCOPE), 'c1', 'b', 'p/'])
    expect(calls[0].values[5]).toBe(1000)
  })

  it('invalidateScope は conn_id + bucket + prefix で消す', async () => {
    const { db, calls } = fakeDb()
    await createResponseCache(db).invalidateScope('c1', 'b', 'p/')
    expect(calls[0].text).toContain('DELETE FROM storage_response_cache')
    expect(calls[0].values).toEqual(['c1', 'b', 'p/'])
  })

  it('invalidateConnection は conn_id の全行を消す', async () => {
    const { db, calls } = fakeDb()
    await createResponseCache(db).invalidateConnection('c1')
    expect(calls[0].text).toContain('WHERE conn_id = $1')
    expect(calls[0].values).toEqual(['c1'])
  })

  // キャッシュはリクエストを壊さない。DB が落ちていても素通りさせる。
  it('DB が例外を投げても get は null を返す', async () => {
    const db: Queryable = { query: async () => { throw new Error('db down') } }
    expect(await createResponseCache(db).get(SCOPE)).toBeNull()
  })

  it('DB が例外を投げても set / invalidate は throw しない', async () => {
    const db: Queryable = { query: async () => { throw new Error('db down') } }
    const cache = createResponseCache(db)
    await expect(cache.set(SCOPE, { ok: true })).resolves.toBeUndefined()
    await expect(cache.invalidateScope('c1', 'b', 'p/')).resolves.toBeUndefined()
    await expect(cache.invalidateConnection('c1')).resolves.toBeUndefined()
  })
})
