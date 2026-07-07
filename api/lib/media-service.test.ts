import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { createPools, closePools } from '../db.js'
import { loadEnv } from '../env.js'
import type { ConnectionConfig } from '../storage.js'

vi.mock('./media-analyze.js', async importOriginal => {
  const mod = await importOriginal<typeof import('./media-analyze.js')>()
  return {
    ...mod,
    analyzeAudio: vi.fn(async () => ({
      peaks: [[-0.1, 0.1]] as Array<[number, number]>,
      durationSec: 2.5,
      sampleRate: 16000,
      spectrogramPng: Buffer.from([0x89, 0x50]),
    })),
  }
})
const { createMediaService } = await import('./media-service.js')
const { getCachedMedia, mediaCacheKey } = await import('./media-cache.js')

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })

const env = loadEnv({
  DATABASE_URL_RW: RW,
  DATABASE_URL_RO: RW,
  ENCRYPTION_KEY: '0'.repeat(64),
  ALLOWED_ORIGINS: 'http://localhost:5173',
})

// GetObjectCommand / HeadObjectCommand / ListObjectsV2Command に応答する S3 スタブ。
// keys: key -> body。list は全キーを 1 ページで返す。
function stubStorage(keys: Record<string, Buffer>): S3Client {
  return {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name
      const key = cmd.input.Key as string
      if (name === 'GetObjectCommand') {
        const body = keys[key]
        if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
        return { Body: Readable.from(body), ContentLength: body.length }
      }
      if (name === 'HeadObjectCommand') {
        const body = keys[key]
        if (!body) throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
        return { ETag: '"stub-etag"', ContentLength: body.length }
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = (cmd.input.Prefix as string) ?? ''
        return {
          Contents: Object.entries(keys)
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => ({ Key: k, Size: v.length })),
          IsTruncated: false,
        }
      }
      throw new Error(`unexpected command ${name}`)
    },
  } as unknown as S3Client
}

function makeService(keys: Record<string, Buffer>) {
  return createMediaService({
    pools,
    getStorage: async () => stubStorage(keys),
    getConnectionConfig: async () => ({ listObjectsVersion: 'v2' } as ConnectionConfig),
    env,
  })
}

beforeEach(async () => {
  await pools.rw.query('TRUNCATE media_cache')
})
afterAll(() => closePools(pools))

describe('analyzeOne', () => {
  it('解析して media_cache に保存し、2 回目はキャッシュから返す', async () => {
    const svc = makeService({ 'a.wav': Buffer.from('fake') })
    const req = { connId: 'c1', bucket: 'b', key: 'a.wav', etag: 'stub-etag' }
    const r1 = await svc.analyzeOne(req)
    expect(r1.durationSec).toBe(2.5)
    expect(r1.hasSpectrogram).toBe(true)
    expect(r1.cacheKey).toBe(mediaCacheKey(req))
    const cached = await getCachedMedia(pools.ro, r1.cacheKey)
    expect(cached?.durationSec).toBe(2.5)
    // 2 回目 — analyzeAudio は追加で呼ばれない
    const { analyzeAudio } = await import('./media-analyze.js')
    const calls = (analyzeAudio as ReturnType<typeof vi.fn>).mock.calls.length
    const r2 = await svc.analyzeOne(req)
    expect(r2).toEqual(r1)
    expect((analyzeAudio as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })
})
