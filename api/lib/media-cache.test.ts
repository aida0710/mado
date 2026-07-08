import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import {
  getCachedMedia,
  getCachedSpectrogram,
  mediaCacheKey,
  upsertMediaCache,
} from './media-cache.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })

beforeEach(() => pools.rw.query('TRUNCATE media_cache'))
afterAll(() => closePools(pools))

describe('media-cache', () => {
  it('mediaCacheKey は etag / entryPath を含み決定的', () => {
    const a = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.wav', etag: 'e1' })
    const b = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.wav', etag: 'e1' })
    const c = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.wav', etag: 'e2' })
    const d = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.tar', entryPath: 'a.wav', etag: 'e1' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('upsert → get の round trip / spectrogram 有無 / meta', async () => {
    const key = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'k.wav', etag: 'e' })
    expect(await getCachedMedia(pools.ro, key)).toBeNull()
    const meta = {
      codec: 'pcm_s16le',
      container: 'wav',
      channels: 1,
      bitsPerSample: 16,
      bitRate: 256000,
      sizeBytes: 32044,
      peakDb: -0.1,
      rmsDb: -3.2,
    }
    await upsertMediaCache(pools.rw, key, {
      peaks: [[-0.5, 0.5]],
      durationSec: 1.5,
      sampleRate: 16000,
      spectrogramPng: Buffer.from([1, 2, 3]),
      meta,
    })
    const got = await getCachedMedia(pools.ro, key)
    expect(got).toEqual({
      cacheKey: key,
      peaks: [[-0.5, 0.5]],
      durationSec: 1.5,
      sampleRate: 16000,
      hasSpectrogram: true,
      meta,
    })
    expect(await getCachedSpectrogram(pools.ro, key)).toEqual(Buffer.from([1, 2, 3]))
    // 再 upsert は上書き
    await upsertMediaCache(pools.rw, key, {
      peaks: [[0, 0]],
      durationSec: 2,
      sampleRate: null,
      spectrogramPng: null,
      meta: { ...meta, channels: 2 },
    })
    const got2 = await getCachedMedia(pools.ro, key)
    expect(got2?.durationSec).toBe(2)
    expect(got2?.hasSpectrogram).toBe(false)
    expect(got2?.meta?.channels).toBe(2)
  })

  it('meta IS NULL の旧行はキャッシュミス扱い (自然にバックフィルされる)', async () => {
    const key = mediaCacheKey({ connId: 'c', bucket: 'b', key: 'old.wav', etag: 'e' })
    // meta カラム追加前の行を模して直接 INSERT (meta なし)
    await pools.rw.query(
      `INSERT INTO media_cache (cache_key, peaks, spectrogram, duration_sec, sample_rate)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, JSON.stringify([[-1, 1]]), null, 1, 16000],
    )
    expect(await getCachedMedia(pools.ro, key)).toBeNull()
  })
})
