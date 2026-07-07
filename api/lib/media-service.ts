// media-worker の中核。単一ファイルの同期解析 (analyzeOne) と、
// ディレクトリ / tar スキャンのジョブ実行 (runNextScanJob) を提供する。
// worker.ts (HTTP + ループ) から使われる。api コンテナはこれを import しない
// (ffmpeg は worker にしか無い)。
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'
import { Readable as ReadableCtor } from 'node:stream'
import type { Pools } from '../db.js'
import type { Env } from '../env.js'
import type { ConnectionConfig } from '../storage.js'
import type { GetStorage } from '../routes/_connId.js'
import { analyzeAudio, MediaAnalyzeError, type AnalyzeResult } from './media-analyze.js'
import {
  getCachedMedia,
  mediaCacheKey,
  upsertMediaCache,
  type CachedMedia,
  type MediaRef,
} from './media-cache.js'
import { createSemaphore } from './semaphore.js'
import {
  DatasetStatsAccumulator,
  isAudioName,
  pairWebdataset,
} from './media-stats.js'
import { extractTarEntry, type ArchiveKind } from './tar-stream.js'
import { iterateTarEntries } from './tar-iterate.js'

export type AnalyzeRequest = MediaRef

export type AnalyzeResponse = CachedMedia

export interface MediaServiceDeps {
  pools: Pools
  getStorage: GetStorage
  getConnectionConfig: (connId: string) => Promise<ConnectionConfig>
  env: Env
}

export interface MediaService {
  analyzeOne(req: AnalyzeRequest, signal?: AbortSignal): Promise<AnalyzeResponse>
  runNextScanJob(): Promise<boolean>
  requeueStale(): Promise<void>
  cleanup(): Promise<void>
}

const PROBE_HEAD_BYTES = 256 * 1024
// tar 内エントリを解析するときの 1 エントリ上限 (storage-preview.ts の
// TAR_ENTRY_MAX_BYTES と同値)。
const ENTRY_MAX_BYTES = 100 * 1024 * 1024

function detectArchive(key: string): ArchiveKind | null {
  const k = key.toLowerCase()
  if (k.endsWith('.tar.gz') || k.endsWith('.tgz')) return 'gz'
  if (k.endsWith('.tar.xz')) return 'xz'
  if (k.endsWith('.tar')) return 'tar'
  return null
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const sem = createSemaphore(deps.env.MEDIA_CONCURRENCY)
  const timeoutMs = deps.env.MEDIA_ANALYZE_TIMEOUT_SEC * 1000

  // signal を渡すと、呼び出し元が中断した際に「次の ffmpeg パス」だけでなく
  // 進行中の S3 リクエスト自体も打ち切れる (aws-sdk v3 の abortSignal オプション)。
  async function openObjectStream(
    storage: S3Client, bucket: string, key: string, range?: string, signal?: AbortSignal,
  ): Promise<NodeJS.ReadableStream> {
    const r = await storage.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }),
      { abortSignal: signal },
    )
    return r.Body as unknown as Readable
  }

  // Buffer から解析する (tar エントリ / スキャン内)。openStream は 2 回呼ばれても
  // Buffer なので追加 I/O なし。
  function analyzeBuffer(buf: Buffer, signal?: AbortSignal): Promise<AnalyzeResult> {
    return analyzeAudio({
      openStream: async () => ReadableCtor.from(buf) as NodeJS.ReadableStream,
      probeHead: async () => buf.subarray(0, PROBE_HEAD_BYTES),
      timeoutMs,
      maxSpectrogramWidth: deps.env.MEDIA_SPECTROGRAM_MAX_WIDTH,
      signal,
    })
  }

  async function analyzeAndCache(
    ref: MediaRef,
    doAnalyze: () => Promise<AnalyzeResult>,
  ): Promise<AnalyzeResponse> {
    const cacheKey = mediaCacheKey(ref)
    const cached = await getCachedMedia(deps.pools.ro, cacheKey)
    if (cached) return cached
    const result = await doAnalyze()
    await upsertMediaCache(deps.pools.rw, cacheKey, result)
    return {
      cacheKey,
      peaks: result.peaks,
      durationSec: result.durationSec,
      sampleRate: result.sampleRate,
      hasSpectrogram: result.spectrogramPng != null,
    }
  }

  async function analyzeOne(req: AnalyzeRequest, signal?: AbortSignal): Promise<AnalyzeResponse> {
    const release = await sem.acquire()
    try {
      const storage = await deps.getStorage(req.connId)
      if (req.entryPath) {
        // tar 内エントリ: 全ストリームを 1 回流してエントリを Buffer 化 → Buffer から解析
        const kind = detectArchive(req.key)
        if (!kind) throw new MediaAnalyzeError('not an archive', '')
        return await analyzeAndCache(req, async () => {
          const stream = await openObjectStream(storage, req.bucket, req.key, undefined, signal)
          const extracted = await extractTarEntry(stream, kind, req.entryPath!, ENTRY_MAX_BYTES)
          if (!extracted || extracted.truncated) {
            throw new MediaAnalyzeError('entry not found or too large', '')
          }
          return analyzeBuffer(extracted.buffer, signal)
        })
      }
      return await analyzeAndCache(req, () => analyzeAudio({
        openStream: () => openObjectStream(storage, req.bucket, req.key, undefined, signal),
        probeHead: async () => {
          const head = await openObjectStream(
            storage, req.bucket, req.key, `bytes=0-${PROBE_HEAD_BYTES - 1}`, signal,
          )
          return readAll(head)
        },
        timeoutMs,
        maxSpectrogramWidth: deps.env.MEDIA_SPECTROGRAM_MAX_WIDTH,
        signal,
      }))
    } finally {
      release()
    }
  }

  // ── スキャン ──────────────────────────────────────────────

  interface ScanPayload {
    connId: string
    bucket: string
    prefix?: string
    tarKey?: string
  }

  async function listAllKeys(
    storage: S3Client,
    connId: string,
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const cfg = await deps.getConnectionConfig(connId)
    const keys: string[] = []
    if (cfg.listObjectsVersion === 'v1') {
      let marker: string | undefined
      for (;;) {
        const out = await storage.send(new ListObjectsCommand({
          Bucket: bucket, Prefix: prefix, Marker: marker, MaxKeys: 1000,
        }))
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key)
        if (!out.IsTruncated || keys.length >= deps.env.MEDIA_SCAN_MAX_FILES) break
        marker = out.NextMarker ?? keys[keys.length - 1]
      }
    } else {
      let token: string | undefined
      for (;;) {
        const out = await storage.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000,
        }))
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key)
        if (!out.IsTruncated || keys.length >= deps.env.MEDIA_SCAN_MAX_FILES) break
        token = out.NextContinuationToken
      }
    }
    return keys
  }

  async function isCanceled(jobId: number): Promise<boolean> {
    const r = await deps.pools.ro.query<{ status: string }>(
      'SELECT status FROM media_jobs WHERE id = $1', [jobId],
    )
    return r.rows[0]?.status === 'canceled'
  }

  async function setProgress(jobId: number, p: { filesDone: number; filesTotal: number; currentKey: string }): Promise<void> {
    await deps.pools.rw.query(
      'UPDATE media_jobs SET progress = $2 WHERE id = $1',
      [jobId, JSON.stringify(p)],
    )
  }

  async function scanTarget(jobId: number, payload: ScanPayload): Promise<'done' | 'canceled'> {
    const storage = await deps.getStorage(payload.connId)
    const acc = new DatasetStatsAccumulator()

    // 統計に加えつつキャッシュも温める共通処理
    const analyzeEntry = async (ref: MediaRef, body: Buffer): Promise<void> => {
      try {
        const r = await analyzeAndCache(ref, () => analyzeBuffer(body))
        acc.addAudio(r.durationSec, r.sampleRate)
      } catch (e) {
        if (e instanceof MediaAnalyzeError) {
          acc.addAudio(null, null) // 解析失敗はカウントのみ (スキャンは続行)
        } else {
          throw e
        }
      }
    }

    const readText = (body: Buffer, name: string): string => {
      const text = body.toString('utf8')
      if (name.toLowerCase().endsWith('.json')) {
        try {
          const j = JSON.parse(text) as { text?: unknown }
          return typeof j.text === 'string' ? j.text : ''
        } catch {
          return ''
        }
      }
      return text
    }

    if (payload.tarKey) {
      // ── tar スキャン: 1 パスで全エントリを処理 ──
      const kind = detectArchive(payload.tarKey)
      if (!kind) throw new Error('unsupported archive extension')
      const etagOut = await storage.send(new HeadObjectCommand({ Bucket: payload.bucket, Key: payload.tarKey }))
      const etag = (etagOut.ETag ?? '').replaceAll('"', '')
      let filesDone = 0
      const stream = await openObjectStream(storage, payload.bucket, payload.tarKey)
      let canceled = false
      try {
        await iterateTarEntries(stream, kind, async (header, body) => {
          if (canceled) return
          if (isAudioName(header.name)) {
            await analyzeEntry(
              { connId: payload.connId, bucket: payload.bucket, key: payload.tarKey!, entryPath: header.name, etag },
              body,
            )
            filesDone++
            await setProgress(jobId, { filesDone, filesTotal: -1, currentKey: header.name })
            if (await isCanceled(jobId)) {
              canceled = true
              // ダウンロードを即座に止める。ソースを destroy すると pipeline() が
              // 全ステージを破棄して iterateTarEntries が reject する — EOF まで
              // 読み続けて巨大 tar のダウンロードが完走するのを防ぐ。
              ;(stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void })
                .destroy?.(new Error('scan canceled'))
            }
          } else if (/\.(txt|json)$/i.test(header.name)) {
            acc.addText(readText(body, header.name))
          }
        }, { entryMaxBytes: ENTRY_MAX_BYTES })
      } catch (e) {
        // canceled フラグ後の reject は stream.destroy 起因 — キャンセル扱い。
        // それ以外の例外は今まで通り伝播させる (呼び出し元で 'error' になる)。
        if (!canceled) throw e
      }
      if (canceled) return 'canceled'
    } else {
      // ── prefix スキャン ──
      const prefix = payload.prefix ?? ''
      const keys = await listAllKeys(storage, payload.connId, payload.bucket, prefix)
      if (keys.length >= deps.env.MEDIA_SCAN_MAX_FILES) acc.markTruncated()
      const pairs = pairWebdataset(keys)
      const textKeys = new Set(pairs.map(p => p.text).filter((t): t is string => t != null))
      let filesDone = 0
      const filesTotal = pairs.length

      for (const pair of pairs) {
        if (await isCanceled(jobId)) return 'canceled'
        const head = await storage.send(new HeadObjectCommand({ Bucket: payload.bucket, Key: pair.audio }))
        const etag = (head.ETag ?? '').replaceAll('"', '')
        const body = await readAll(await openObjectStream(storage, payload.bucket, pair.audio))
        await analyzeEntry({ connId: payload.connId, bucket: payload.bucket, key: pair.audio, etag }, body)
        filesDone++
        await setProgress(jobId, { filesDone, filesTotal, currentKey: pair.audio })
      }
      for (const tk of textKeys) {
        const body = await readAll(await openObjectStream(storage, payload.bucket, tk))
        acc.addText(readText(body, tk))
      }
    }

    const targetKey = [payload.connId, payload.bucket, payload.tarKey ?? payload.prefix ?? ''].join('\n')
    await deps.pools.rw.query(
      `INSERT INTO dataset_stats (target_key, result, scanned_at)
       VALUES ($1, $2, now())
       ON CONFLICT (target_key) DO UPDATE SET result = EXCLUDED.result, scanned_at = now()`,
      [targetKey, JSON.stringify(acc.result())],
    )
    return 'done'
  }

  async function claimNextJob(): Promise<{ id: number; payload: ScanPayload } | null> {
    const client = await deps.pools.rw.connect()
    try {
      await client.query('BEGIN')
      const r = await client.query<{ id: number; payload: ScanPayload }>(
        `UPDATE media_jobs SET status = 'processing', started_at = now()
         WHERE id = (
           SELECT id FROM media_jobs WHERE status = 'queued'
           ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, payload`,
      )
      await client.query('COMMIT')
      return r.rows[0] ?? null
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async function runNextScanJob(): Promise<boolean> {
    const job = await claimNextJob()
    if (!job) return false

    try {
      const outcome = await scanTarget(job.id, job.payload)
      await deps.pools.rw.query(
        `UPDATE media_jobs SET status = $2, finished_at = now() WHERE id = $1 AND status <> 'canceled'`,
        [job.id, outcome],
      )
    } catch (e) {
      await deps.pools.rw.query(
        `UPDATE media_jobs SET status = 'error', error = $2, finished_at = now() WHERE id = $1`,
        [job.id, (e as Error).message.slice(0, 2000)],
      )
    }
    return true
  }

  async function requeueStale(): Promise<void> {
    await deps.pools.rw.query(
      `UPDATE media_jobs SET status = 'queued', started_at = NULL WHERE status = 'processing'`,
    )
  }

  async function cleanup(): Promise<void> {
    await deps.pools.rw.query(
      `DELETE FROM media_cache WHERE created_at < now() - make_interval(days => $1)`,
      [deps.env.MEDIA_CACHE_MAX_AGE_DAYS],
    )
    await deps.pools.rw.query(
      `DELETE FROM media_jobs
        WHERE status IN ('done', 'error', 'canceled')
          AND finished_at < now() - interval '7 days'`,
    )
  }

  return { analyzeOne, runNextScanJob, requeueStale, cleanup }
}
