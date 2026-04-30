import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { mountHpcRoutes } from './hpc.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountHpcRoutes(app, { pools, writeToken: 'TKN' })

beforeEach(async () => {
  await pools.rw.query('TRUNCATE hpc_metrics RESTART IDENTITY')
})
afterAll(() => closePools(pools))

describe('POST /api/hpc/push', () => {
  it('inserts a row with body as output', async () => {
    const body = 'job1 R\njob2 Q\n'
    const res = await app.request(
      '/api/hpc/push?host=miyabi&command=qstat',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer TKN', 'Content-Type': 'text/plain' },
        body,
      }
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const r = await pools.rw.query(
      'SELECT host, command, output FROM hpc_metrics'
    )
    expect(r.rows).toEqual([
      { host: 'miyabi', command: 'qstat', output: body },
    ])
  })

  it('rejects without token (401)', async () => {
    const res = await app.request('/api/hpc/push?host=m&command=q', {
      method: 'POST',
      body: 'x',
    })
    expect(res.status).toBe(401)
    const r = await pools.rw.query('SELECT count(*) FROM hpc_metrics')
    expect(r.rows[0].count).toBe('0')
  })

  it('400 if host missing', async () => {
    const res = await app.request('/api/hpc/push?command=q', {
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
    const res = await app.request('/api/hpc/push?host=m', {
      method: 'POST',
      headers: { Authorization: 'Bearer TKN' },
      body: 'x',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'host and command query params are required',
    })
  })

  it('413 if body exceeds 1MB', async () => {
    const big = 'x'.repeat(1_000_001)
    const res = await app.request(
      '/api/hpc/push?host=m&command=q',
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

describe('GET /api/hpc', () => {
  it('returns latest row per (host, command)', async () => {
    await pools.rw.query(
      `INSERT INTO hpc_metrics(host, command, output, collected_at) VALUES
       ('miyabi','qstat','old', now() - interval '1 hour'),
       ('miyabi','qstat','new', now()),
       ('osaka', 'pjstat','o',  now())`
    )
    const res = await app.request('/api/hpc')
    expect(res.status).toBe(200)
    const rows = (await res.json()) as Array<{
      host: string; command: string; output: string; collected_at: string
    }>
    const byHost = Object.fromEntries(rows.map(r => [r.host, r.output]))
    expect(byHost.miyabi).toBe('new')
    expect(byHost.osaka).toBe('o')
    expect(rows).toHaveLength(2)
    // collected_at must be ISO 8601, not a Date object or epoch number
    for (const row of rows) {
      expect(typeof row.collected_at).toBe('string')
      expect(() => new Date(row.collected_at).toISOString()).not.toThrow()
    }
  })

  it('returns empty array when table is empty', async () => {
    const res = await app.request('/api/hpc')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('treats (host, command) as the latest key', async () => {
    // Same host, two commands — both should appear, latest each.
    await pools.rw.query(
      `INSERT INTO hpc_metrics(host, command, output, collected_at) VALUES
       ('miyabi','qstat','q-old', now() - interval '1 hour'),
       ('miyabi','qstat','q-new', now()),
       ('miyabi','df',   'd-old', now() - interval '2 hour'),
       ('miyabi','df',   'd-new', now())`
    )
    const res = await app.request('/api/hpc')
    const rows = (await res.json()) as Array<{
      host: string; command: string; output: string
    }>
    expect(rows).toHaveLength(2)
    const byCommand = Object.fromEntries(
      rows.map(r => [r.command, r.output]),
    )
    expect(byCommand.qstat).toBe('q-new')
    expect(byCommand.df).toBe('d-new')
  })
})
