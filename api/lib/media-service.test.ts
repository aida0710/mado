import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { pack } from 'tar-stream'
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

// tar-stream の pack() でメモリ上に tar Buffer を組み立てる (tar スキャンテスト用)。
async function makeTar(entries: Array<{ name: string; body: Buffer }>): Promise<Buffer> {
  const p = pack()
  for (const e of entries) p.entry({ name: e.name }, e.body)
  p.finalize()
  const chunks: Buffer[] = []
  for await (const c of p) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
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
  await pools.rw.query('TRUNCATE media_cache, media_jobs, dataset_stats')
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

describe('runNextScanJob', () => {
  it('prefix スキャン: 音声を解析して dataset_stats を書き、ジョブを done にする', async () => {
    const svc = makeService({
      'ds/u1.wav': Buffer.from('a'),
      'ds/u1.txt': Buffer.from('hello world'),
      'ds/u2.wav': Buffer.from('b'),
      'ds/readme.md': Buffer.from('x'),
    })
    await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload) VALUES ($1, $2)`,
      ['c1\nb\nds/', JSON.stringify({ connId: 'c1', bucket: 'b', prefix: 'ds/' })],
    )
    expect(await svc.runNextScanJob()).toBe(true)
    const job = (await pools.ro.query('SELECT status, progress FROM media_jobs')).rows[0]
    expect(job.status).toBe('done')
    const stats = (await pools.ro.query('SELECT result FROM dataset_stats WHERE target_key = $1', ['c1\nb\nds/'])).rows[0]
    expect(stats.result.fileCount).toBe(2)          // u1.wav, u2.wav
    expect(stats.result.textFileCount).toBe(1)      // u1.txt
    expect(stats.result.totalDurationSec).toBeCloseTo(5) // 2.5 × 2 (mock)
    // キャッシュも温まっている
    const cacheCount = (await pools.ro.query('SELECT count(*)::int AS n FROM media_cache')).rows[0]
    expect(cacheCount.n).toBe(2)
  })

  it('prefix スキャン: 2 回目はキャッシュ済みファイルをダウンロードせず統計は同じになる', async () => {
    const keys = {
      'ds3/u1.wav': Buffer.from('a'),
      'ds3/u2.wav': Buffer.from('b'),
    }
    const storage = stubStorage(keys)
    const sendSpy = vi.spyOn(storage, 'send')
    const svc = createMediaService({
      pools,
      getStorage: async () => storage,
      getConnectionConfig: async () => ({ listObjectsVersion: 'v2' } as ConnectionConfig),
      env,
    })
    const runScan = async (): Promise<void> => {
      await pools.rw.query(
        `INSERT INTO media_jobs (target_key, payload) VALUES ($1, $2)`,
        ['c1\nb\nds3/', JSON.stringify({ connId: 'c1', bucket: 'b', prefix: 'ds3/' })],
      )
      expect(await svc.runNextScanJob()).toBe(true)
    }

    await runScan()
    const stats1 = (await pools.ro.query(
      'SELECT result FROM dataset_stats WHERE target_key = $1', ['c1\nb\nds3/'],
    )).rows[0].result

    sendSpy.mockClear()
    await runScan()
    const stats2 = (await pools.ro.query(
      'SELECT result FROM dataset_stats WHERE target_key = $1', ['c1\nb\nds3/'],
    )).rows[0].result
    expect(stats2).toEqual(stats1)

    // 2 回目は HeadObject は呼ばれる (etag 確認のため) が、音声本体の
    // GetObject は一切呼ばれていないはず (キャッシュ命中でスキップ)。
    const getObjectCalls = sendSpy.mock.calls.filter(
      ([cmd]) => (cmd as { constructor: { name: string } }).constructor.name === 'GetObjectCommand',
    )
    expect(getObjectCalls.length).toBe(0)
  })

  it('queued が無ければ false', async () => {
    const svc = makeService({})
    expect(await svc.runNextScanJob()).toBe(false)
  })

  it('canceled ジョブはファイル境界で中断される', async () => {
    const svc = makeService({ 'ds/u1.wav': Buffer.from('a'), 'ds/u2.wav': Buffer.from('b') })
    const ins = await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload) VALUES ($1, $2) RETURNING id`,
      ['c1\nb\nds/', JSON.stringify({ connId: 'c1', bucket: 'b', prefix: 'ds/' })],
    )
    // 実行前にキャンセル
    await pools.rw.query(`UPDATE media_jobs SET status='canceled' WHERE id=$1`, [ins.rows[0].id])
    expect(await svc.runNextScanJob()).toBe(false) // queued が無いので拾わない
    const stats = await pools.ro.query('SELECT count(*)::int AS n FROM dataset_stats')
    expect(stats.rows[0].n).toBe(0)
  })

  it('tar スキャン: エントリを解析して dataset_stats を書き、キャッシュも温める', async () => {
    const tarBuf = await makeTar([
      { name: 'u1.wav', body: Buffer.from('a') },
      { name: 'u1.txt', body: Buffer.from('hello world') },
      { name: 'u2.wav', body: Buffer.from('b') },
    ])
    const svc = makeService({ 'shard.tar': tarBuf })
    await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload) VALUES ($1, $2)`,
      ['c1\nb\nshard.tar', JSON.stringify({ connId: 'c1', bucket: 'b', tarKey: 'shard.tar' })],
    )
    expect(await svc.runNextScanJob()).toBe(true)
    const job = (await pools.ro.query('SELECT status FROM media_jobs')).rows[0]
    expect(job.status).toBe('done')
    const stats = (await pools.ro.query('SELECT result FROM dataset_stats WHERE target_key = $1', ['c1\nb\nshard.tar'])).rows[0]
    expect(stats.result.fileCount).toBe(2)          // u1.wav, u2.wav
    expect(stats.result.textFileCount).toBe(1)      // u1.txt
    expect(stats.result.totalDurationSec).toBeCloseTo(5) // 2.5 × 2 (mock)
    // キャッシュは entryPath 込みのキーで 2 件
    const k1 = mediaCacheKey({ connId: 'c1', bucket: 'b', key: 'shard.tar', entryPath: 'u1.wav', etag: 'stub-etag' })
    const k2 = mediaCacheKey({ connId: 'c1', bucket: 'b', key: 'shard.tar', entryPath: 'u2.wav', etag: 'stub-etag' })
    expect(await getCachedMedia(pools.ro, k1)).not.toBeNull()
    expect(await getCachedMedia(pools.ro, k2)).not.toBeNull()
    const cacheCount = (await pools.ro.query('SELECT count(*)::int AS n FROM media_cache')).rows[0]
    expect(cacheCount.n).toBe(2)
  })

  it('tar スキャン: macOS メタデータ (._*, .DS_Store) は統計に混入しない', async () => {
    const tarBuf = await makeTar([
      { name: 'u1.wav', body: Buffer.from('a') },
      { name: 'u1.txt', body: Buffer.from('hello world') },
      // AppleDouble の実体はバイナリ (0x00 0x05 0x16 0x07 ...) — u1.wav の音声
      // として ffmpeg に渡ると失敗し、u1.txt のテキストとして addText に流れると
      // 語彙/文字統計を汚染する。isMacOsMetadata で弾かれるべき。
      { name: '._u1.wav', body: Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]) },
      { name: '._u1.txt', body: Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]) },
      { name: '.DS_Store', body: Buffer.from([0x00, 0x00, 0x00, 0x01]) },
      { name: 'u2.wav', body: Buffer.from('b') },
    ])
    const svc = makeService({ 'shard.tar': tarBuf })
    await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload) VALUES ($1, $2)`,
      ['c1\nb\nshard.tar', JSON.stringify({ connId: 'c1', bucket: 'b', tarKey: 'shard.tar' })],
    )
    expect(await svc.runNextScanJob()).toBe(true)
    const job = (await pools.ro.query('SELECT status FROM media_jobs')).rows[0]
    expect(job.status).toBe('done')
    const stats = (await pools.ro.query('SELECT result FROM dataset_stats WHERE target_key = $1', ['c1\nb\nshard.tar'])).rows[0]
    expect(stats.result.fileCount).toBe(2)     // u1.wav, u2.wav (._u1.wav は除外)
    expect(stats.result.textFileCount).toBe(1) // u1.txt (._u1.txt は除外)
    expect(stats.result.vocabSize).toBe(2)     // hello, world のみ (バイナリ由来のゴミ無し)
    expect(stats.result.totalDurationSec).toBeCloseTo(5) // 2.5 × 2 (mock)
  })

  it('実行中にキャンセルされたら停止し、done に上書きしない', async () => {
    const svc = makeService({ 'ds/u1.wav': Buffer.from('a'), 'ds/u2.wav': Buffer.from('b') })
    const ins = await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload) VALUES ($1, $2) RETURNING id`,
      ['c1\nb\nds/', JSON.stringify({ connId: 'c1', bucket: 'b', prefix: 'ds/' })],
    )
    const jobId = ins.rows[0].id as number
    const { analyzeAudio } = await import('./media-analyze.js')
    const mockFn = analyzeAudio as ReturnType<typeof vi.fn>
    const callsBefore = mockFn.mock.calls.length
    // 1 ファイル目の解析中に cancel API と同じ形でキャンセルを刻む
    mockFn.mockImplementationOnce(async () => {
      await pools.rw.query(
        `UPDATE media_jobs SET status='canceled', finished_at=now() WHERE id=$1`, [jobId],
      )
      return {
        peaks: [[-0.1, 0.1]] as Array<[number, number]>,
        durationSec: 2.5,
        sampleRate: 16000,
        spectrogramPng: Buffer.from([0x89, 0x50]),
      }
    })
    expect(await svc.runNextScanJob()).toBe(true) // ジョブは 1 件処理した
    const job = (await pools.ro.query(
      'SELECT status, finished_at FROM media_jobs WHERE id = $1', [jobId],
    )).rows[0]
    expect(job.status).toBe('canceled') // 'done' に上書きされない
    expect(job.finished_at).not.toBeNull()
    const stats = await pools.ro.query('SELECT count(*)::int AS n FROM dataset_stats')
    expect(stats.rows[0].n).toBe(0) // dataset_stats は書かれない
    // 2 ファイル目 (ds/u2.wav) は解析されない
    expect(mockFn.mock.calls.length).toBe(callsBefore + 1)
  })
})

describe('requeueStale', () => {
  it('processing のまま残ったジョブを queued に戻す', async () => {
    const svc = makeService({})
    await pools.rw.query(
      `INSERT INTO media_jobs (target_key, payload, status, started_at)
       VALUES ('x', '{}', 'processing', now())`,
    )
    await svc.requeueStale()
    const r = await pools.ro.query('SELECT status FROM media_jobs')
    expect(r.rows[0].status).toBe('queued')
  })
})
