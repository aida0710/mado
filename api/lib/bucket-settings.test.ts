import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createBucketSettings, DEFAULT_BUCKET_SETTINGS } from './bucket-settings.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const settings = createBucketSettings(pools)
const CONN = 'testconn01'

beforeEach(async () => {
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await pools.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked)
     VALUES ($1, $1, 'https://s3.example.com/', 'auto', 'v1:enc', 'v1:enc', 'AKIA…0000')`,
    [CONN],
  )
})
afterAll(() => closePools(pools))

describe('createBucketSettings', () => {
  it('行が無ければ既定値', async () => {
    expect(await settings.get(CONN, 'b1')).toEqual(DEFAULT_BUCKET_SETTINGS)
    expect(DEFAULT_BUCKET_SETTINGS).toEqual({ scanEnabled: true, listCacheTtlSec: 86400 })
  })

  it('scan_enabled=false が反映される', async () => {
    await settings.set(CONN, 'b1', 'scan_enabled', 'false')
    expect((await settings.get(CONN, 'b1')).scanEnabled).toBe(false)
  })

  it('バケットごとに独立している', async () => {
    await settings.set(CONN, 'b1', 'scan_enabled', 'false')
    expect((await settings.get(CONN, 'b2')).scanEnabled).toBe(true)
  })

  it('list_cache_ttl_sec が反映される', async () => {
    await settings.set(CONN, 'b1', 'list_cache_ttl_sec', '300')
    expect((await settings.get(CONN, 'b1')).listCacheTtlSec).toBe(300)
  })

  it('壊れた値は既定値に倒す', async () => {
    await settings.set(CONN, 'b1', 'list_cache_ttl_sec', 'いいかんじ')
    expect((await settings.get(CONN, 'b1')).listCacheTtlSec).toBe(86400)
  })

  it('set は UPSERT (同じ key を二度書ける)', async () => {
    await settings.set(CONN, 'b1', 'scan_enabled', 'false')
    await settings.set(CONN, 'b1', 'scan_enabled', 'true')
    expect((await settings.get(CONN, 'b1')).scanEnabled).toBe(true)
  })

  it('接続を消すと設定も消える (CASCADE)', async () => {
    await settings.set(CONN, 'b1', 'scan_enabled', 'false')
    await pools.rw.query('DELETE FROM storage_connections WHERE id=$1', [CONN])
    const n = await pools.rw.query<{ c: number }>('SELECT count(*)::int AS c FROM bucket_settings')
    expect(n.rows[0].c).toBe(0)
  })
})
