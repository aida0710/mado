import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createResponseCache } from './storage-cache.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

beforeEach(() => pools.rw.query('TRUNCATE storage_response_cache'))
afterAll(() => closePools(pools))

const SCOPE = { kind: 'list' as const, connId: 'c1', bucket: 'b', prefix: 'p/' }

describe('storage_response_cache (実 DB)', () => {
  it('set した payload を get で取り戻せる', async () => {
    const cache = createResponseCache(pools.rw)
    await cache.set(SCOPE, { directories: ['p/x/'], files: [] })
    expect(await cache.get(SCOPE)).toEqual({ directories: ['p/x/'], files: [] })
  })

  it('TTL 切れの行は get で返らない', async () => {
    const cache = createResponseCache(pools.rw, -1000)
    await cache.set(SCOPE, { directories: [], files: [] })
    expect(await cache.get(SCOPE)).toBeNull()
  })

  it('invalidateScope は同 prefix の全ページを消す', async () => {
    const cache = createResponseCache(pools.rw)
    await cache.set({ ...SCOPE, continuation: 'tok1' }, { page: 1 })
    await cache.set({ ...SCOPE, continuation: 'tok2' }, { page: 2 })
    await cache.set({ ...SCOPE, prefix: 'other/' }, { page: 9 })
    await cache.invalidateScope('c1', 'b', 'p/')
    expect(await cache.get({ ...SCOPE, continuation: 'tok1' })).toBeNull()
    expect(await cache.get({ ...SCOPE, continuation: 'tok2' })).toBeNull()
    expect(await cache.get({ ...SCOPE, prefix: 'other/' })).toEqual({ page: 9 })
  })

  it('invalidateConnection は接続の全行を消す', async () => {
    const cache = createResponseCache(pools.rw)
    await cache.set(SCOPE, { page: 1 })
    await cache.set({ ...SCOPE, connId: 'c2' }, { page: 2 })
    await cache.invalidateConnection('c1')
    expect(await cache.get(SCOPE)).toBeNull()
    expect(await cache.get({ ...SCOPE, connId: 'c2' })).toEqual({ page: 2 })
  })
})
