import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { createPools, closePools } from '../db.js'
import { loadEnv } from '../env.js'
import type { ConnectionConfig } from '../storage.js'
import { createVirtualTar } from './test-fixtures/virtual-tar.js'

vi.mock('./media-analyze.js', async importOriginal => {
  const mod = await importOriginal<typeof import('./media-analyze.js')>()
  return {
    ...mod,
    // 波形・スペクトログラムの2パスとprobeを再現し、上流を再取得しないことを確認する。
    analyzeAudio: vi.fn(async (opts: import('./media-analyze.js').AnalyzeOpts) => {
      await opts.probeHead()
      for (let pass = 0; pass < 2; pass++) {
        const source = await opts.openStream() as Readable
        for await (const chunk of source) expect(Buffer.isBuffer(chunk)).toBe(true)
      }
      return {
        peaks: [[-0.1, 0.1]] as Array<[number, number]>,
        durationSec: 2.5,
        sampleRate: 16000,
        spectrogramPng: Buffer.from([0x89, 0x50]),
        meta: {
          codec: null,
          container: null,
          channels: null,
          bitsPerSample: null,
          bitRate: null,
          sizeBytes: opts.getSizeBytes ? opts.getSizeBytes() : null,
          peakDb: null,
          rmsDb: null,
        },
      }
    }),
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
function stubStorage(keys: Record<string, Buffer>) {
  return {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = cmd.constructor.name
      const key = cmd.input.Key as string
      if (name === 'GetObjectCommand') {
        const body = keys[key]
        if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
        expect(cmd.input.IfMatch).toBe('"stub-etag"')
        if (cmd.input.Range) {
          const [, start, end] = String(cmd.input.Range).match(/^bytes=(\d+)-(\d+)$/)!
          const part = body.subarray(Number(start), Number(end) + 1)
          return { Body: Readable.from(part), ContentLength: part.length, ContentRange: `bytes ${start}-${end}/${body.length}` }
        }
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
    }),
  }
}

function makeService(keys: Record<string, Buffer>, storage = stubStorage(keys)) {
  return createMediaService({
    pools,
    getStorage: async () => storage as unknown as S3Client,
    getConnectionConfig: async () => ({ listObjectsVersion: 'v2' } as ConnectionConfig),
    env,
  })
}

beforeEach(async () => {
  await pools.rw.query('TRUNCATE media_cache')
})
afterAll(() => closePools(pools))

describe('analyzeOne', () => {
  it('同時に同じ音声を解析してもS3本文は一度だけ取得する', async () => {
    const storage = stubStorage({ 'a.wav': Buffer.from('fake audio') })
    const service = makeService({}, storage)
    try {
      const ref = { connectionId: 'c1', bucket: 'b', key: 'a.wav', etag: 'stub-etag' }
      const results = await Promise.all(Array.from({ length: 3 }, () => service.analyzeOne(ref)))
      expect(results.every(result => result.meta?.sizeBytes === 10)).toBe(true)
      expect(storage.send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(1)
    } finally { service.close() }
  })

  it('10GiBの本文を手前に持つtarでも音声の範囲だけ取得する', async () => {
    const tar = createVirtualTar(10)
    let fetchedBytes = 0
    const storage = {
      send: vi.fn(async (command: { input: { Range?: string; IfMatch?: string } }) => {
        if (command instanceof HeadObjectCommand) return { ContentLength: tar.size, ETag: '"stub-etag"' }
        expect(command.input.Range).toBeDefined()
        expect(command.input.IfMatch).toBe('"stub-etag"')
        const [, start, end] = command.input.Range!.match(/^bytes=(\d+)-(\d+)$/)!
        const body = await tar.read(Number(start), Number(end) - Number(start) + 1)
        fetchedBytes += body.length
        return { Body: Readable.from(body), ContentLength: body.length, ContentRange: `bytes ${start}-${end}/${tar.size}` }
      }),
    }
    const service = makeService({}, storage)
    try {
      const result = await service.analyzeOne({ connectionId: 'c1', bucket: 'b', key: 'large.tar', entryPath: 'd/a.txt', etag: 'stub-etag' })
      expect(result.meta?.sizeBytes).toBe(6)
      expect(fetchedBytes).toBeLessThan(1024 * 1024)
      expect(storage.send.mock.calls.filter(([command]) => command instanceof GetObjectCommand)).toHaveLength(3)
    } finally { service.close() }
  })
  it('解析して media_cache に保存し、2 回目はキャッシュから返す', async () => {
    const svc = makeService({ 'a.wav': Buffer.from('fake') })
    const req = { connectionId: 'c1', bucket: 'b', key: 'a.wav', etag: 'stub-etag' }
    const r1 = await svc.analyzeOne(req)
    expect(r1.durationSec).toBe(2.5)
    expect(r1.hasSpectrogram).toBe(true)
    expect(r1.cacheKey).toBe(mediaCacheKey(req))
    // GetObject の ContentLength (=stub の body.length) が meta.sizeBytes に渡っている
    expect(r1.meta?.sizeBytes).toBe(Buffer.from('fake').length)
    const cached = await getCachedMedia(pools.ro, r1.cacheKey)
    expect(cached?.durationSec).toBe(2.5)
    // 2 回目 — analyzeAudio は追加で呼ばれない
    const { analyzeAudio } = await import('./media-analyze.js')
    const calls = (analyzeAudio as ReturnType<typeof vi.fn>).mock.calls.length
    const r2 = await svc.analyzeOne(req)
    expect(r2).toEqual(r1)
    expect((analyzeAudio as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })

  it('tar エントリ抽出後の buffer.length が meta.sizeBytes として渡る', async () => {
    const { readFileSync } = await import('node:fs')
    const tarBuf = readFileSync(new URL('./test-fixtures/sample.tar', import.meta.url))
    const svc = makeService({ 'archive.tar': tarBuf })
    const req = {
      connectionId: 'c1', bucket: 'b', key: 'archive.tar', entryPath: 'd/a.txt', etag: 'stub-etag',
    }
    const r = await svc.analyzeOne(req)
    // d/a.txt (sample.tar 内) は 6 バイト
    expect(r.meta?.sizeBytes).toBe(6)
  })
})
