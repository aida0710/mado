// media-worker の中核。単一ファイルの同期解析 (analyzeOne) を提供する。
// worker.ts (HTTP) から使われる。api コンテナはこれを import しない
// (ffmpeg は worker にしか無い)。
import {
  GetObjectCommand,
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
import { extractTarEntry, type ArchiveKind } from './tar-stream.js'

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

  async function cleanup(): Promise<void> {
    await deps.pools.rw.query(
      `DELETE FROM media_cache WHERE created_at < now() - make_interval(days => $1)`,
      [deps.env.MEDIA_CACHE_MAX_AGE_DAYS],
    )
  }

  return { analyzeOne, cleanup }
}
