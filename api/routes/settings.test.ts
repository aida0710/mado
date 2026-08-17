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
  // app_settings は接続に紐づかないので TRUNCATE storage_connections CASCADE では
  // 消えない。マイグレーションの初期値と同じ状態に戻す。
  await pools.rw.query('TRUNCATE app_settings')
  await pools.rw.query(
    `INSERT INTO app_settings(key, value) VALUES ('tags_enabled', 'true')`,
  )
})
afterAll(() => closePools(pools))

describe('app settings', () => {
  it('GET /settings returns all settings as a key-value map', async () => {
    const res = await app.request('/settings')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags_enabled: 'true' })
  })

  it('PUT /settings/:key updates the value', async () => {
    const res = await app.request('/settings/tags_enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'false' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    expect(await (await app.request('/settings')).json())
      .toEqual({ tags_enabled: 'false' })
  })

  it('PUT is idempotent (upsert, not duplicate rows)', async () => {
    for (const v of ['false', 'false', 'true']) {
      await app.request('/settings/tags_enabled', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: v }),
      })
    }
    const r = await pools.ro.query('SELECT count(*)::int AS n FROM app_settings')
    expect(r.rows[0].n).toBe(1)
    expect(await (await app.request('/settings')).json())
      .toEqual({ tags_enabled: 'true' })
  })

  // 未知のキーを弾く。UI のタイプミスや古いクライアントが設定表を汚さないように。
  it('PUT rejects an unknown key', async () => {
    const res = await app.request('/settings/nope', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'true' }),
    })
    expect(res.status).toBe(400)
    const r = await pools.ro.query(`SELECT count(*)::int AS n FROM app_settings WHERE key = 'nope'`)
    expect(r.rows[0].n).toBe(0)
  })

  it('PUT rejects a non-string value', async () => {
    const res = await app.request('/settings/tags_enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: false }),
    })
    expect(res.status).toBe(400)
    // 値は変わらない。
    expect(await (await app.request('/settings')).json())
      .toEqual({ tags_enabled: 'true' })
  })
})
