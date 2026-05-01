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
})
afterAll(() => closePools(pools))

describe('GET /api/notes/:slug', () => {
  it('returns {exists: false} for non-existent slug', async () => {
    const res = await app.request('/api/notes/home')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ exists: false })
  })

  it('returns body + editor + timestamp after PUT', async () => {
    const put = await app.request('/api/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '# Hello\nworld', editor: 'tanaka' }),
    })
    expect(put.status).toBe(200)

    const get = await app.request('/api/notes/home')
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

describe('PUT /api/notes/:slug', () => {
  it('upserts: second write overwrites the first', async () => {
    await app.request('/api/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'first', editor: 'a' }),
    })
    const res = await app.request('/api/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'second', editor: 'b' }),
    })
    expect(res.status).toBe(200)
    const get = await app.request('/api/notes/home')
    const body = (await get.json()) as { body: string; last_editor: string }
    expect(body.body).toBe('second')
    expect(body.last_editor).toBe('b')
  })

  it('returns 400 when editor is missing', async () => {
    const res = await app.request('/api/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when editor is empty', async () => {
    const res = await app.request('/api/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x', editor: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('keeps body and editor independent across slugs', async () => {
    await app.request('/api/notes/home', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'home body', editor: 'a' }),
    })
    await app.request('/api/notes/other', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'other body', editor: 'b' }),
    })
    const home = (await (await app.request('/api/notes/home')).json()) as { body: string }
    const other = (await (await app.request('/api/notes/other')).json()) as { body: string }
    expect(home.body).toBe('home body')
    expect(other.body).toBe('other body')
  })
})
