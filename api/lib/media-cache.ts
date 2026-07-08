import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { AnalyzeResult, MediaMeta } from './media-analyze.js'

export interface MediaRef {
  connId: string
  bucket: string
  key: string
  entryPath?: string
  etag: string
}

// sha256(JSON([connId,bucket,key,entryPath,etag])) — 不透明かつ衝突安全な PK。
// ETag を含めるので S3 側の再アップロードで自然に別キーになる。
export function mediaCacheKey(ref: MediaRef): string {
  return createHash('sha256')
    .update(JSON.stringify([ref.connId, ref.bucket, ref.key, ref.entryPath ?? '', ref.etag]))
    .digest('hex')
}

export interface CachedMedia {
  cacheKey: string
  peaks: Array<[number, number]>
  durationSec: number | null
  sampleRate: number | null
  hasSpectrogram: boolean
  meta: MediaMeta | null
}

export async function getCachedMedia(pool: Pool, cacheKey: string): Promise<CachedMedia | null> {
  const r = await pool.query<{
    peaks: Array<[number, number]>
    duration_sec: number | null
    sample_rate: number | null
    has_spec: boolean
    meta: MediaMeta | null
  }>(
    `SELECT peaks, duration_sec, sample_rate, meta, (spectrogram IS NOT NULL) AS has_spec
       FROM media_cache WHERE cache_key = $1 AND meta IS NOT NULL`,
    [cacheKey],
  )
  const row = r.rows[0]
  if (!row) return null
  return {
    cacheKey,
    peaks: row.peaks,
    durationSec: row.duration_sec,
    sampleRate: row.sample_rate,
    hasSpectrogram: row.has_spec,
    meta: row.meta,
  }
}

export async function getCachedSpectrogram(pool: Pool, cacheKey: string): Promise<Buffer | null> {
  const r = await pool.query<{ spectrogram: Buffer | null }>(
    'SELECT spectrogram FROM media_cache WHERE cache_key = $1',
    [cacheKey],
  )
  return r.rows[0]?.spectrogram ?? null
}

export async function upsertMediaCache(
  pool: Pool,
  cacheKey: string,
  result: AnalyzeResult & { durationSec: number | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO media_cache (cache_key, peaks, spectrogram, duration_sec, sample_rate, meta)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (cache_key) DO UPDATE SET
       peaks = EXCLUDED.peaks,
       spectrogram = EXCLUDED.spectrogram,
       duration_sec = EXCLUDED.duration_sec,
       sample_rate = EXCLUDED.sample_rate,
       meta = EXCLUDED.meta,
       created_at = now()`,
    [
      cacheKey,
      JSON.stringify(result.peaks),
      result.spectrogramPng,
      result.durationSec,
      result.sampleRate,
      JSON.stringify(result.meta),
    ],
  )
}
