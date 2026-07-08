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
  await pools.rw.query('TRUNCATE media_cache')
})
afterAll(() => closePools(pools))

const REF = { connId: 'c1', bucket: 'b', key: 'a.wav', etag: 'etag1' }

const META = {
  codec: 'pcm_s16le',
  container: 'wav',
  channels: 1,
  bitsPerSample: 16,
  bitRate: 256000,
  sizeBytes: 32044,
  peakDb: -0.1,
  rmsDb: -3.2,
}

describe('GET /media/analyze', () => {
  it('キャッシュ命中なら worker を呼ばず 200、meta も乗る', async () => {
    const cacheKey = mediaCacheKey(REF)
    await upsertMediaCache(pools.rw, cacheKey, {
      peaks: [[-1, 1]],
      durationSec: 3,
      sampleRate: 16000,
      spectrogramPng: Buffer.from([1]),
      meta: META,
    })
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cacheKey).toBe(cacheKey)
    expect(body.durationSec).toBe(3)
    expect(body.hasSpectrogram).toBe(true)
    expect(body.meta).toEqual(META)
    expect(workerFetch).not.toHaveBeenCalled()
  })

  it('未計算なら worker に proxy してそのまま返す (meta 込み)', async () => {
    workerFetch.mockResolvedValue(new Response(JSON.stringify({
      cacheKey: 'k',
      peaks: [[0, 0]],
      durationSec: 1,
      sampleRate: null,
      hasSpectrogram: false,
      meta: META,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const res = await makeApp().request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cacheKey).toBe('k')
    expect(body.meta).toEqual(META)
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

  it('HeadObject の AccessDenied は 404 に潰されず rethrow される', async () => {
    const denyStorage = {
      send: async () => {
        throw Object.assign(new Error('access denied'), { name: 'AccessDenied' })
      },
    } as unknown as S3Client
    const app = new Hono()
    mountStorageMediaRoutes(app, {
      getStorage: async () => denyStorage,
      pools,
      env,
      workerFetch: workerFetch as unknown as typeof fetch,
    })
    const res = await app.request('/storage/c1/media/analyze?bucket=b&key=a.wav')
    // onError 未搭載のテスト app では rethrow は Hono 既定の 500 になる。
    // 重要なのは「404 ではない」こと (internal.ts では explainStorageError が翻訳する)。
    expect(res.status).not.toBe(404)
    expect(res.status).toBe(500)
    expect(workerFetch).not.toHaveBeenCalled()
  })
})

describe('GET /media/spectrogram', () => {
  it('PNG を immutable Cache-Control 付きで返す / 無ければ 404', async () => {
    const cacheKey = mediaCacheKey(REF)
    await upsertMediaCache(pools.rw, cacheKey, {
      peaks: [], durationSec: 1, sampleRate: null, spectrogramPng: Buffer.from([0x89, 0x50]), meta: META,
    })
    const res = await makeApp().request(`/storage/c1/media/spectrogram?cacheKey=${cacheKey}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    const missing = await makeApp().request('/storage/c1/media/spectrogram?cacheKey=none')
    expect(missing.status).toBe(404)
  })
})
