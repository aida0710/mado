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

describe('タグ割り当て', () => {
  async function createTag(name: string, color = '#123456'): Promise<TagRow> {
    return (await (await app.request('/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    })).json()) as TagRow
  }

  beforeEach(async () => {
    await seedConnection(pools, 'conn000001')
  })

  it('GET はバッチで path→tagId[] を返す (割り当てなしは空配列)', async () => {
    const tag = await createTag('A')
    await app.request('/storage/conn000001/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'bkt', kind: 'prefix', path: 'a/', tagId: tag.id }),
    })

    const res = await app.request(
      '/storage/conn000001/tags?bucket=bkt&kind=prefix&paths=a/&paths=b/',
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ 'a/': [tag.id] })
  })

  it('PUT は冪等 (同じ組み合わせを二度投げてもエラーにならない)', async () => {
    const tag = await createTag('B')
    const body = JSON.stringify({ bucket: 'bkt', kind: 'file', path: 'x.txt', tagId: tag.id })
    const r1 = await app.request('/storage/conn000001/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    })
    const r2 = await app.request('/storage/conn000001/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const res = await app.request('/storage/conn000001/tags?bucket=bkt&kind=file&paths=x.txt')
    expect(await res.json()).toEqual({ 'x.txt': [tag.id] })
  })

  it('kind=bucket のとき path は "" に正規化される', async () => {
    const tag = await createTag('C')
    await app.request('/storage/conn000001/tags', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'bkt', kind: 'bucket', path: 'ignored', tagId: tag.id }),
    })
    const res = await app.request('/storage/conn000001/tags?bucket=bkt&kind=bucket&paths=')
    expect(await res.json()).toEqual({ '': [tag.id] })
  })

  it('DELETE で割り当てを解除できる', async () => {
    const tag = await createTag('D')
    const body = JSON.stringify({ bucket: 'bkt', kind: 'prefix', path: 'a/', tagId: tag.id })
    await app.request('/storage/conn000001/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    })
    const del = await app.request('/storage/conn000001/tags', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body,
    })
    expect(del.status).toBe(200)
    const res = await app.request('/storage/conn000001/tags?bucket=bkt&kind=prefix&paths=a/')
    expect(await res.json()).toEqual({})
  })

  it('paths が空なら GET は空オブジェクトを返す', async () => {
    const res = await app.request('/storage/conn000001/tags?bucket=bkt&kind=prefix')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })
})

describe('タグ横断検索', () => {
  beforeEach(async () => {
    await seedConnection(pools, 'conn000001')
    await seedConnection(pools, 'conn000002')
  })

  it('選んだタグのいずれかを含む対象を、接続内の全バケットから返す', async () => {
    const tagA = await (await app.request('/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'search-a', color: '#111111' }),
    })).json() as TagRow
    const tagB = await (await app.request('/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'search-b', color: '#222222' }),
    })).json() as TagRow

    const assign = (bucket: string, kind: string, path: string, tagId: string) =>
      app.request('/storage/conn000001/tags', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, kind, path, tagId }),
      })
    await assign('bkt-1', 'bucket', '', tagA.id)
    await assign('bkt-2', 'prefix', 'dir/', tagB.id)
    await assign('bkt-2', 'file', 'dir/file.txt', tagA.id)
    // 別接続 (conn000002) の割り当ては横断検索の対象外
    await app.request('/storage/conn000002/tags', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'other', kind: 'bucket', path: '', tagId: tagA.id }),
    })

    const res = await app.request(
      `/storage/conn000001/tags/search?tagId=${tagA.id}&tagId=${tagB.id}`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { tagId: tagA.id, bucket: 'bkt-1', kind: 'bucket', path: '' },
      { tagId: tagB.id, bucket: 'bkt-2', kind: 'prefix', path: 'dir/' },
      { tagId: tagA.id, bucket: 'bkt-2', kind: 'file', path: 'dir/file.txt' },
    ])
  })

  it('tagId が無ければ空配列を返す', async () => {
    const res = await app.request('/storage/conn000001/tags/search')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})
