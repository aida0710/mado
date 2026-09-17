import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools, type Pools } from '../db.js'
import { mountStorageFavoritesRoutes } from './storage-favorites.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountStorageFavoritesRoutes(app, { pools })

const TEST_CONN_ID = 'testconn01'
const OTHER_CONN_ID = 'otherconn1'

async function seedConnection(p: Pools, id: string): Promise<void> {
  await p.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style)
     VALUES ($1, $1, 'https://test.example/', 'auto', 'v1:enc', 'v1:enc', 'AKIA…XYZ4', true)
     ON CONFLICT (id) DO NOTHING`,
    [id],
  )
}

beforeEach(async () => {
  // CASCADE で storage_favorite_buckets も削除される。
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await seedConnection(pools, TEST_CONN_ID)
  await seedConnection(pools, OTHER_CONN_ID)
})
afterAll(() => closePools(pools))

describe('お気に入りバケット', () => {
  it('GET は並び順の一覧を返す (初期は空)', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/favorites`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('PUT で追加し、DELETE で外せる', async () => {
    let res = await app.request(`/storage/${TEST_CONN_ID}/favorites/dataset`, { method: 'PUT' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    res = await app.request(`/storage/${TEST_CONN_ID}/favorites/example-bucket`, { method: 'PUT' })
    expect(res.status).toBe(200)

    res = await app.request(`/storage/${TEST_CONN_ID}/favorites`)
    expect(await res.json()).toEqual(['dataset', 'example-bucket'])

    res = await app.request(`/storage/${TEST_CONN_ID}/favorites/dataset`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    res = await app.request(`/storage/${TEST_CONN_ID}/favorites`)
    expect(await res.json()).toEqual(['example-bucket'])
  })

  it('PUT は冪等 (同じバケットを二度追加してもエラーにならない)', async () => {
    await app.request(`/storage/${TEST_CONN_ID}/favorites/x`, { method: 'PUT' })
    const res = await app.request(`/storage/${TEST_CONN_ID}/favorites/x`, { method: 'PUT' })
    expect(res.status).toBe(200)
    const list = (await (await app.request(`/storage/${TEST_CONN_ID}/favorites`)).json()) as string[]
    expect(list).toEqual(['x'])
  })

  it('無い行への DELETE も冪等', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/favorites/missing`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('お気に入りは接続ごとに別の一覧になる', async () => {
    await app.request(`/storage/${TEST_CONN_ID}/favorites/only-for-test`, { method: 'PUT' })
    await app.request(`/storage/${OTHER_CONN_ID}/favorites/only-for-other`, { method: 'PUT' })

    const a = (await (await app.request(`/storage/${TEST_CONN_ID}/favorites`)).json()) as string[]
    const b = (await (await app.request(`/storage/${OTHER_CONN_ID}/favorites`)).json()) as string[]
    expect(a).toEqual(['only-for-test'])
    expect(b).toEqual(['only-for-other'])
  })
})
