import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { mountS3FavoritesRoutes } from './s3-favorites.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

const app = new Hono()
mountS3FavoritesRoutes(app, { pools })

beforeEach(async () => {
  await pools.rw.query('TRUNCATE s3_favorite_buckets')
})
afterAll(() => closePools(pools))

describe('S3 favorite buckets', () => {
  it('GET returns sorted list (empty by default)', async () => {
    const res = await app.request('/api/s3/favorites')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('PUT adds and DELETE removes', async () => {
    let res = await app.request('/api/s3/favorites/dataset', { method: 'PUT' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    res = await app.request('/api/s3/favorites/aida-bucket', { method: 'PUT' })
    expect(res.status).toBe(200)

    res = await app.request('/api/s3/favorites')
    expect(await res.json()).toEqual(['aida-bucket', 'dataset'])

    res = await app.request('/api/s3/favorites/dataset', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    res = await app.request('/api/s3/favorites')
    expect(await res.json()).toEqual(['aida-bucket'])
  })

  it('PUT is idempotent (no error on duplicate)', async () => {
    await app.request('/api/s3/favorites/x', { method: 'PUT' })
    const res = await app.request('/api/s3/favorites/x', { method: 'PUT' })
    expect(res.status).toBe(200)
    const list = (await (await app.request('/api/s3/favorites')).json()) as string[]
    expect(list).toEqual(['x'])
  })

  it('DELETE on missing row is idempotent', async () => {
    const res = await app.request('/api/s3/favorites/missing', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
