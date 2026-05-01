import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { mountMetricsRoutes } from './metrics.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountMetricsRoutes(app, { pools, writeToken: 'TKN' })

beforeEach(async () => {
  await pools.rw.query('TRUNCATE metrics RESTART IDENTITY')
  await pools.rw.query(`UPDATE feature_flags SET enabled = TRUE WHERE name = 'metrics'`)
})
afterAll(() => closePools(pools))

describe('POST /api/metrics/push', () => {
  it('inserts a row with body as output, category defaults to general', async () => {
    const body = 'job1 R\njob2 Q\n'
    const res = await app.request(
      '/api/metrics/push?host=example&command=uptime',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer TKN', 'Content-Type': 'text/plain' },
        body,
      }
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const r = await pools.rw.query(
      'SELECT host, command, category, output FROM metrics'
    )
    expect(r.rows).toEqual([
      { host: 'example', command: 'uptime', category: 'general', output: body },
    ])
  })

  it('uses ?category= when provided', async () => {
    const res = await app.request(
      '/api/metrics/push?host=example&command=uptime&category=ジョブ一覧',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer TKN', 'Content-Type': 'text/plain' },
        body: 'x',
      }
    )
    expect(res.status).toBe(200)
    const r = await pools.rw.query(
      'SELECT category FROM metrics'
    )
    expect(r.rows).toEqual([{ category: 'ジョブ一覧' }])
  })

  it('rejects without token (401)', async () => {
    const res = await app.request('/api/metrics/push?host=m&command=q', {
      method: 'POST',
      body: 'x',
    })
    expect(res.status).toBe(401)
    const r = await pools.rw.query('SELECT count(*) FROM metrics')
    expect(r.rows[0].count).toBe('0')
  })

  it('400 if host missing', async () => {
    const res = await app.request('/api/metrics/push?command=q', {
      method: 'POST',
      headers: { Authorization: 'Bearer TKN' },
      body: 'x',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'host and command query params are required',
    })
  })

  it('400 if command missing', async () => {
    const res = await app.request('/api/metrics/push?host=m', {
      method: 'POST',
      headers: { Authorization: 'Bearer TKN' },
      body: 'x',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'host and command query params are required',
    })
  })

  it('returns 503 when the metrics feature flag is disabled', async () => {
    await pools.rw.query(
      `UPDATE feature_flags SET enabled = FALSE WHERE name = 'metrics'`,
    )
    const res = await app.request('/api/metrics/push?host=m&command=q', {
      method: 'POST',
      headers: { Authorization: 'Bearer TKN', 'Content-Type': 'text/plain' },
      body: 'x',
    })
    expect(res.status).toBe(503)
    const r = await pools.rw.query('SELECT count(*) FROM metrics')
    expect(r.rows[0].count).toBe('0')
  })

  it('413 if body exceeds 1MB', async () => {
    const big = 'x'.repeat(1_000_001)
    const res = await app.request(
      '/api/metrics/push?host=m&command=q',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer TKN', 'Content-Type': 'text/plain' },
        body: big,
      },
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'request body too large' })
  })
})

describe('GET /api/metrics', () => {
  it('returns latest row per (host, command, category) including category', async () => {
    await pools.rw.query(
      `INSERT INTO metrics(host, command, category, output, collected_at) VALUES
       ('alpha','uptime','ジョブ一覧','old', now() - interval '30 minutes'),
       ('alpha','uptime','ジョブ一覧','new', now()),
       ('beta', 'df',    'ジョブ一覧','o',  now())`
    )
    const res = await app.request('/api/metrics')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{
      host: string; command: string; category: string;
      output: string; collected_at: string
    }>
    expect(rows).toHaveLength(2)
    const byHost = Object.fromEntries(rows.map(r => [r.host, r.output]))
    expect(byHost.alpha).toBe('new')
    expect(byHost.beta).toBe('o')
    for (const row of rows) {
      expect(row.category).toBe('ジョブ一覧')
      expect(typeof row.collected_at).toBe('string')
      expect(() => new Date(row.collected_at).toISOString()).not.toThrow()
    }
  })

  it('returns empty array when table is empty', async () => {
    const res = await app.request('/api/metrics')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('excludes rows older than 1 hour', async () => {
    await pools.rw.query(
      `INSERT INTO metrics(host, command, category, output, collected_at) VALUES
       ('stale','uptime','x','old', now() - interval '2 hours'),
       ('fresh','uptime','x','new', now())`
    )
    const res = await app.request('/api/metrics')
    const rows = (await res.json()) as Array<{ host: string }>
    expect(rows.map(r => r.host)).toEqual(['fresh'])
  })

  it('returns 503 when the metrics feature flag is disabled', async () => {
    await pools.rw.query(
      `UPDATE feature_flags SET enabled = FALSE WHERE name = 'metrics'`,
    )
    const res = await app.request('/api/metrics')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/disabled/)
  })

  it('keeps separate latest rows per category for the same host/command', async () => {
    await pools.rw.query(
      `INSERT INTO metrics(host, command, category, output, collected_at) VALUES
       ('alpha','uptime','ジョブ一覧','jobs',  now()),
       ('alpha','uptime','node使用率','nodes', now()),
       ('alpha','uptime','トークン数','toks',  now())`
    )
    const res = await app.request('/api/metrics')
    const rows = (await res.json()) as Array<{
      host: string; category: string; output: string
    }>
    expect(rows).toHaveLength(3)
    const byCategory = Object.fromEntries(
      rows.map(r => [r.category, r.output]),
    )
    expect(byCategory['ジョブ一覧']).toBe('jobs')
    expect(byCategory['node使用率']).toBe('nodes')
    expect(byCategory['トークン数']).toBe('toks')
  })
})
