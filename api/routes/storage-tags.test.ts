import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools, type Pools } from '../db.js'
import { mountStorageTagsRoutes } from './storage-tags.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountStorageTagsRoutes(app, { pools })

interface TagRow { id: string; name: string; color: string }

beforeEach(async () => {
  // CASCADE で storage_tag_assignments も消える。
  await pools.rw.query('TRUNCATE storage_tags CASCADE')
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
})
afterAll(() => closePools(pools))

async function seedConnection(p: Pools, id: string): Promise<void> {
  await p.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style)
     VALUES ($1, $1, 'https://test.example/', 'auto', 'v1:enc', 'v1:enc', 'AKIA…XYZ4', true)
     ON CONFLICT (id) DO NOTHING`,
    [id],
  )
}

describe('タグレジストリ', () => {
  it('GET /tags は空配列を返す (初期状態)', async () => {
    const res = await app.request('/tags')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST /tags で作成し、GET /tags に反映される', async () => {
    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '重要', color: '#ff0000' }),
    })
    expect(res.status).toBe(200)
    const created = await res.json() as TagRow
    expect(created.name).toBe('重要')
    expect(created.color).toBe('#ff0000')
    expect(created.id).toHaveLength(10)

    const list = await app.request('/tags')
    expect(await list.json()).toEqual([created])
  })

  it('POST /tags は name 重複を 409 で拒否する', async () => {
    await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '重要', color: '#ff0000' }),
    })
    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '重要', color: '#00ff00' }),
    })
    expect(res.status).toBe(409)
  })

  it('POST /tags は不正な color を 400 で拒否する', async () => {
    const res = await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', color: 'red' }),
    })
    expect(res.status).toBe(400)
  })

  it('PUT /tags/:id で name/color を部分更新できる', async () => {
    const created = await (await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'A', color: '#111111' }),
    })).json() as TagRow

    const res = await app.request(`/tags/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#222222' }),
    })
    expect(res.status).toBe(200)
    const updated = await res.json() as TagRow
    expect(updated.name).toBe('A')
    expect(updated.color).toBe('#222222')
  })

  it('PUT /tags/:id は存在しない id を 404 で返す', async () => {
    const res = await app.request('/tags/doesnotexist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: '#222222' }),
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /tags/:id で削除でき、割り当ても連鎖削除される', async () => {
    await seedConnection(pools, 'conn000001')
    const created = await (await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B', color: '#333333' }),
    })).json() as TagRow
    await pools.rw.query(
      `INSERT INTO storage_tag_assignments (tag_id, connection_id, bucket, target_kind, target_path)
       VALUES ($1, 'conn000001', 'bkt', 'bucket', '')`,
      [created.id],
    )

    const res = await app.request(`/tags/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const remaining = await pools.rw.query(
      'SELECT * FROM storage_tag_assignments WHERE tag_id = $1', [created.id],
    )
    expect(remaining.rows).toEqual([])
  })
})
