import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { mountSettingsRoutes } from './settings.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountSettingsRoutes(app, { pools })

beforeEach(async () => {
  // Reset flags to defaults from migration seed.
  await pools.rw.query(`UPDATE feature_flags SET enabled = TRUE`)
})
afterAll(() => closePools(pools))

describe('GET /api/settings/flags', () => {
  it('returns the seeded flags map', async () => {
    const res = await app.request('/api/settings/flags')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, boolean>
    expect(body.metrics).toBe(true)
  })
})

describe('PUT /api/settings/flags/:name', () => {
  it('disables a flag and GET reflects it', async () => {
    const put = await app.request('/api/settings/flags/metrics', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({ ok: true, name: 'metrics', enabled: false })

    const get = await app.request('/api/settings/flags')
    const body = (await get.json()) as Record<string, boolean>
    expect(body.metrics).toBe(false)
  })

  it('re-enables a flag', async () => {
    await app.request('/api/settings/flags/metrics', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    const put = await app.request('/api/settings/flags/metrics', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(put.status).toBe(200)
    const get = await app.request('/api/settings/flags')
    const body = (await get.json()) as Record<string, boolean>
    expect(body.metrics).toBe(true)
  })

  it('returns 400 on malformed body', async () => {
    const res = await app.request('/api/settings/flags/metrics', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 for unknown flag', async () => {
    const res = await app.request('/api/settings/flags/nonexistent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(404)
  })
})
