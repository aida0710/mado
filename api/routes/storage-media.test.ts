import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { createPools, closePools } from '../db.js'
import { loadEnv } from '../env.js'
import { mediaCacheKey, upsertMediaCache } from '../lib/media-cache.js'
import { mountStorageMediaRoutes } from './storage-media.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })

const env = loadEnv({
  DATABASE_URL_RW: RW,
  DATABASE_URL_RO: RW,
  ENCRYPTION_KEY: '0'.repeat(64),
  ALLOWED_ORIGINS: 'http://localhost:5173',
})

// HeadObject だけ返せばよい (Get は worker 側の仕事)
const stubStorage = {
  send: async (cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'HeadObjectCommand') {
      return { ETag: '"etag1"', ContentLength: 100 }
    }
    throw new Error('unexpected')
  },
} as unknown as S3Client

const workerFetch = vi.fn()

function makeApp(): Hono {
  const app = new Hono()
  mountStorageMediaRoutes(app, {
    getStorage: async () => stubStorage,
    pools,
    env,
    workerFetch: workerFetch as unknown as typeof fetch,
  })
  return app
}

beforeEach(async () => {
  workerFetch.mockReset()
  await pools.rw.query('TRUNCATE media_cache, media_jobs, dataset_stats')
})
afterAll(() => closePools(pools))

const REF = { connId: 'c1', bucket: 'b', key: 'a.wav', etag: 'etag1' }

describe('GET /media/analyze', () => {
  it('キャッシュ命中なら worker を呼ばず 200', async () => {
    const cacheKey = mediaCacheKey(REF)
    await upsertMediaCache(pools.rw, cacheKey, {
      peaks: [[-1, 1]], durationSec: 3, sampleRate: 16000, spectrogramPng: Buffer.from([1]),
    })
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cacheKey).toBe(cacheKey)
    expect(body.durationSec).toBe(3)
    expect(body.hasSpectrogram).toBe(true)
    expect(workerFetch).not.toHaveBeenCalled()
  })

  it('未計算なら worker に proxy してそのまま返す', async () => {
    workerFetch.mockResolvedValue(new Response(JSON.stringify({
      cacheKey: 'k', peaks: [[0, 0]], durationSec: 1, sampleRate: null, hasSpectrogram: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(200)
    expect((await res.json()).cacheKey).toBe('k')
    // worker へは etag 込みで POST される
    const [url, init] = workerFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${env.MEDIA_WORKER_URL}/analyze`)
    expect(JSON.parse(init.body as string)).toEqual(REF)
  })

  it('worker 不達なら 503', async () => {
    workerFetch.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(503)
  })

  it('worker の 422 は素通しされる', async () => {
    workerFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'no' }), { status: 422 }))
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(422)
  })
})

describe('GET /media/spectrogram', () => {
  it('PNG を immutable Cache-Control 付きで返す / 無ければ 404', async () => {
    const cacheKey = mediaCacheKey(REF)
    await upsertMediaCache(pools.rw, cacheKey, {
      peaks: [], durationSec: 1, sampleRate: null, spectrogramPng: Buffer.from([0x89, 0x50]),
    })
    const res = await makeApp().request(`/storage/c1/media/spectrogram?cacheKey=${cacheKey}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    const missing = await makeApp().request('/storage/c1/media/spectrogram?cacheKey=none')
    expect(missing.status).toBe(404)
  })
})

describe('scan lifecycle', () => {
  it('POST scan → 202 / 二重投入は同じジョブに合流 / status で見える / cancel できる', async () => {
    const app = makeApp()
    const r1 = await app.request('/storage/c1/media/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: 'ds/' }),
    })
    expect(r1.status).toBe(202)
    const { jobId } = await r1.json()
    const r2 = await app.request('/storage/c1/media/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: 'ds/' }),
    })
    expect((await r2.json()).jobId).toBe(jobId)

    const st = await app.request('/storage/c1/media/scan-status?bucket=b&prefix=ds/')
    const stBody = await st.json()
    expect(stBody.job.id).toBe(jobId)
    expect(stBody.job.status).toBe('queued')
    expect(stBody.stats).toBeNull()

    const cancel = await app.request('/storage/c1/media/scan-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    })
    expect(cancel.status).toBe(200)
    const st2 = await app.request('/storage/c1/media/scan-status?bucket=b&prefix=ds/')
    expect((await st2.json()).job.status).toBe('canceled')
  })

  it('done 済みジョブが残っていても再投入できる (部分ユニーク)', async () => {
    await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload, status, finished_at)
       VALUES ($1, '{}', 'done', now())`,
      ['c1\nb\nds/'],
    )
    const res = await makeApp().request('/storage/c1/media/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket: 'b', prefix: 'ds/' }),
    })
    expect(res.status).toBe(202)
  })

  it('dataset_stats があれば scan-status で stats が返る', async () => {
    await pools.rw.query(
      `INSERT INTO dataset_stats (target_key, result, scanned_at) VALUES ($1, $2, now())`,
      ['c1\nb\nds/', JSON.stringify({ fileCount: 5 })],
    )
    const res = await makeApp().request('/storage/c1/media/scan-status?bucket=b&prefix=ds/')
    const body = await res.json()
    expect(body.stats.fileCount).toBe(5)
    expect(body.scannedAt).toBeTruthy()
  })
})
