import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools, type Pools } from '../db.js'
import { mountStorageLineageRoutes } from './storage-lineage.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountStorageLineageRoutes(app, { pools })

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
  // CASCADE で storage_lineage_links も削除される。
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await seedConnection(pools, TEST_CONN_ID)
  await seedConnection(pools, OTHER_CONN_ID)
})
afterAll(() => closePools(pools))

const parent = { bucket: 'raw', path: '2024-01/' }
const child = { bucket: 'clean', path: 'v2/' }

describe('storage lineage links', () => {
  it('GET returns empty array by default', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST creates a link and GET returns it', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: true; id: number }
    expect(body.ok).toBe(true)
    expect(typeof body.id).toBe('number')

    const list = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json()
    expect(list).toEqual([{
      id: body.id,
      parentBucket: 'raw', parentPath: '2024-01/',
      childBucket: 'clean', childPath: 'v2/',
      createdBy: 'aida', createdAt: expect.any(String),
    }])
  })

  it('POST is idempotent (same pair twice -> one row, same id)', async () => {
    const first = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })).json() as { id: number }

    const second = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'someone-else' }),
    })).json() as { id: number }

    expect(second.id).toBe(first.id)
    const list = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json() as unknown[]
    expect(list).toHaveLength(1)
  })

  it('POST rejects a self-link (parent === child)', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child: parent, editor: 'aida' }),
    })
    expect(res.status).toBe(400)
  })

  // 循環の防止。N:N (複数の親 / 複数の子) は許すが、閉路は登録させない。
  const post = (parent: object, child: object) =>
    app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })

  const A = { bucket: 'a', path: '' }
  const B = { bucket: 'b', path: '' }
  const C = { bucket: 'c', path: '' }

  it('POST rejects a 2-node cycle (A->B then B->A)', async () => {
    expect((await post(A, B)).status).toBe(200)
    const res = await post(B, A)
    expect(res.status).toBe(409)

    // 弾かれた側は書き込まれていない。
    const list = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json() as unknown[]
    expect(list).toHaveLength(1)
  })

  it('POST rejects a longer cycle (A->B->C then C->A)', async () => {
    await post(A, B)
    await post(B, C)
    expect((await post(C, A)).status).toBe(409)
  })

  // 同じノードに複数の親 / 複数の子がぶら下がるのは正当 (閉路ではない)。
  it('POST allows N:N fan-in / fan-out', async () => {
    expect((await post(A, C)).status).toBe(200)
    expect((await post(B, C)).status).toBe(200)   // C に親が 2 つ
    const D = { bucket: 'd', path: '' }
    expect((await post(A, D)).status).toBe(200)   // A に子が 2 つ
  })

  // 合流して再び分岐する DAG (ダイヤモンド) は閉路ではないので通す。
  it('POST allows a diamond (A->B, A->C, B->D, C->D)', async () => {
    const D = { bucket: 'd', path: '' }
    await post(A, B)
    await post(A, C)
    await post(B, D)
    expect((await post(C, D)).status).toBe(200)
  })

  it('DELETE removes the link', async () => {
    const created = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })).json() as { id: number }

    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const list = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json()
    expect(list).toEqual([])
  })

  it('DELETE on missing id is idempotent', async () => {
    const res = await app.request(`/storage/${TEST_CONN_ID}/lineage-links/999999`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('links are scoped per-connection', async () => {
    await app.request(`/storage/${TEST_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, child, editor: 'aida' }),
    })
    await app.request(`/storage/${OTHER_CONN_ID}/lineage-links`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent: { bucket: 'x', path: '' }, child: { bucket: 'y', path: '' }, editor: 'aida' }),
    })
    const a = await (await app.request(`/storage/${TEST_CONN_ID}/lineage-links`)).json() as unknown[]
    const b = await (await app.request(`/storage/${OTHER_CONN_ID}/lineage-links`)).json() as unknown[]
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})
