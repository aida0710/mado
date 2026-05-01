import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { mountSqlRoutes } from './sql.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountSqlRoutes(app, { pools, writeToken: 'TKN' })

beforeEach(async () => {
  await pools.rw.query('DROP TABLE IF EXISTS sql_test_t')
})
afterAll(() => closePools(pools))

const auth = { Authorization: 'Bearer TKN', 'Content-Type': 'application/json' }

describe('POST /sql/write', () => {
  it('runs INSERT with params and returns rowCount', async () => {
    await pools.rw.query('CREATE TABLE sql_test_t (id int, name text)')
    const res = await app.request('/sql/write', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        sql: 'INSERT INTO sql_test_t(id,name) VALUES ($1,$2)',
        params: [1, 'a'],
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rowCount: 1 })
  })

  it('returns rows for SELECT', async () => {
    await pools.rw.query('CREATE TABLE sql_test_t (id int)')
    await pools.rw.query('INSERT INTO sql_test_t(id) VALUES (7),(8)')
    const res = await app.request('/sql/write', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sql: 'SELECT id FROM sql_test_t ORDER BY id' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [{ id: 7 }, { id: 8 }] })
  })

  it('returns rows for INSERT ... RETURNING', async () => {
    await pools.rw.query('CREATE TABLE sql_test_t (id serial PRIMARY KEY, name text)')
    const res = await app.request('/sql/write', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        sql: `INSERT INTO sql_test_t(name) VALUES ('x') RETURNING id, name`,
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: { id: number; name: string }[] }
    expect(body.rows[0].name).toBe('x')
    expect(typeof body.rows[0].id).toBe('number')
  })

  it('passes through PG error message on 400', async () => {
    const res = await app.request('/sql/write', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ sql: 'SELECT * FROM no_such_table' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/no_such_table/)
  })

  it('400 on malformed JSON body', async () => {
    const res = await app.request('/sql/write', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ params: [1] }), // missing sql
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBeTruthy()
  })

  it('rejects without token (401)', async () => {
    const res = await app.request('/sql/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    })
    expect(res.status).toBe(401)
  })
})

// ボディサイズ制限 (1MB) は hono/body-limit ミドルウェアで強制される。
// この動作は routes/metrics.test.ts:413 で検証済み (ボディが 1MB を超える場合) —
// 同じミドルウェアファクトリと制限定数パターンを使用しているため、
// Hono の app.request() が Content-Length 事前チェックをスキップするという
// ハーネスの癖があるので JSON content-type でテストを重複させる価値はない。
