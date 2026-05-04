import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { mountNotesRoutes } from './notes.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountNotesRoutes(app, { pools })

beforeEach(async () => {
  await pools.rw.query('TRUNCATE notes')
  await pools.rw.query('TRUNCATE notes_history')
})
afterAll(() => closePools(pools))

describe('GET /notes/:slug', () => {
  it('returns {exists: false} for non-existent slug', async () => {
    const res = await app.request('/notes/home')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: false })
  })

  it('returns body + editor + timestamp after PUT', async () => {
    const put = await app.request('/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '# Hello\nworld', editor: 'tanaka' }),
    })
    expect(put.status).toBe(200)

    const get = await app.request('/notes/home')
    expect(get.status).toBe(200)
    const body = (await get.json()) as {
      exists: true; body: string; last_editor: string; last_edited_at: string
    }
    expect(body.exists).toBe(true)
    expect(body.body).toBe('# Hello\nworld')
    expect(body.last_editor).toBe('tanaka')
    expect(typeof body.last_edited_at).toBe('string')
  })
})

describe('PUT /notes/:slug', () => {
  it('upserts: second write overwrites the first', async () => {
    await app.request('/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'first', editor: 'a' }),
    })
    const res = await app.request('/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'second', editor: 'b' }),
    })
    expect(res.status).toBe(200)
    const get = await app.request('/notes/home')
    const body = (await get.json()) as { body: string; last_editor: string }
    expect(body.body).toBe('second')
    expect(body.last_editor).toBe('b')
  })

  it('returns 400 when editor is missing', async () => {
    const res = await app.request('/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when editor is empty', async () => {
    const res = await app.request('/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x', editor: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('keeps body and editor independent across slugs', async () => {
    await app.request('/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'home body', editor: 'a' }),
    })
    await app.request('/notes/other', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'other body', editor: 'b' }),
    })
    const home = (await (await app.request('/notes/home')).json()) as { body: string }
    const other = (await (await app.request('/notes/other')).json()) as { body: string }
    expect(home.body).toBe('home body')
    expect(other.body).toBe('other body')
  })
})

describe('PUT /notes/:slug — 履歴記録', () => {
  it('PUT 成功時に notes_history へ INSERT される (slug 単位で append)', async () => {
    await app.request('/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'v1', editor: 'tanaka' }),
    })
    await app.request('/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'v2 updated', editor: 'sato' }),
    })
    const r = await pools.rw.query(
      `SELECT body, editor, size_bytes FROM notes_history
         WHERE slug='home' ORDER BY edited_at, id`,
    )
    expect(r.rows.length).toBe(2)
    expect(r.rows[0]).toMatchObject({ body: 'v1', editor: 'tanaka', size_bytes: 2 })
    expect(r.rows[1]).toMatchObject({ body: 'v2 updated', editor: 'sato', size_bytes: 10 })
  })
})

describe('GET /notes/:slug/history', () => {
  beforeEach(async () => {
    for (const [body, editor] of [['v1', 'a'], ['v2', 'b'], ['v3', 'a']] as const) {
      await pools.rw.query(
        `INSERT INTO notes_history(slug, body, size_bytes, editor)
         VALUES('home', $1, $2, $3)`,
        [body, body.length, editor],
      )
    }
  })

  it('versions を edited_at DESC で返す', async () => {
    const res = await app.request('/notes/home/history')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { versions: Array<{ editor: string }> }
    expect(json.versions.length).toBe(3)
    expect(json.versions[0].editor).toBe('a') // 最新 (v3)
    expect(json.versions[1].editor).toBe('b')
  })

  it('limit でページサイズを制限', async () => {
    const res = await app.request('/notes/home/history?limit=2')
    const json = (await res.json()) as { versions: unknown[] }
    expect(json.versions.length).toBe(2)
  })

  it('該当 slug 無しは空配列', async () => {
    const res = await app.request('/notes/missing/history')
    const json = (await res.json()) as { versions: unknown[] }
    expect(json.versions).toEqual([])
  })
})

describe('GET /notes/:slug/history/:id', () => {
  it('特定版の body / 編集者 / size を返す', async () => {
    const ins = await pools.rw.query<{ id: string }>(
      `INSERT INTO notes_history(slug, body, size_bytes, editor)
       VALUES('home', '# v42', 5, 'tanaka') RETURNING id`,
    )
    const id = ins.rows[0].id
    const res = await app.request(`/notes/home/history/${id}`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { body: string; editor: string; slug: string }
    expect(json).toMatchObject({ body: '# v42', editor: 'tanaka', slug: 'home' })
  })

  it('id 未存在で 404', async () => {
    const res = await app.request('/notes/home/history/999999999')
    expect(res.status).toBe(404)
  })

  it('id が数字でない場合 400', async () => {
    const res = await app.request('/notes/home/history/abc')
    expect(res.status).toBe(400)
  })
})
