import type { Pools } from '../db.js'
import type { Env } from '../env.js'
import type { ConnectionConfig } from '../storage.js'
import type { GetStorage } from '../routes/_storageRequest.js'
import { analyzeAudio } from './media-analyze.js'
import { getCachedMedia, mediaCacheKey, upsertMediaCache, type CachedMedia, type MediaRef } from './media-cache.js'
import { createSemaphore } from './semaphore.js'
import { SharedRequests } from './shared-requests.js'
import { TarIndexCache } from './tar-index-cache.js'
import { spoolMediaInput } from './media-input.js'
import { openMediaSource } from './media-source.js'

export type AnalyzeRequest = MediaRef
export type AnalyzeResponse = CachedMedia

export interface MediaServiceDeps {
  pools: Pools
  getStorage: GetStorage
  getConnectionConfig: (connectionId: string) => Promise<ConnectionConfig>
  env: Env
}

export interface MediaService {
  analyzeOne(req: AnalyzeRequest, signal?: AbortSignal): Promise<AnalyzeResponse>
  cleanup(): Promise<void>
  close(): void
}

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const slots = createSemaphore(deps.env.MEDIA_CONCURRENCY)
  const requests = new SharedRequests<AnalyzeResponse>()
  const tarIndexes = new TarIndexCache()
  const timeoutMs = deps.env.MEDIA_ANALYZE_TIMEOUT_SEC * 1000

  async function analyzeAndCache(ref: MediaRef, signal: AbortSignal): Promise<AnalyzeResponse> {
    const cacheKey = mediaCacheKey(ref)
    const cached = await getCachedMedia(deps.pools.ro, cacheKey)
    if (cached) return cached
    const release = await slots.acquire(signal)
    try {
      const storage = await deps.getStorage(ref.connectionId)
      const input = await spoolMediaInput({
        source: await openMediaSource({ storage, ref, tarIndexes, signal }), signal,
      })
      try {
        const analyzed = await analyzeAudio({
          ...input, timeoutMs, maxSpectrogramWidth: deps.env.MEDIA_SPECTROGRAM_MAX_WIDTH, signal,
        })
        signal.throwIfAborted()
        await upsertMediaCache(deps.pools.rw, ref, analyzed)
        return {
          cacheKey, peaks: analyzed.peaks, durationSec: analyzed.durationSec,
          sampleRate: analyzed.sampleRate, hasSpectrogram: analyzed.spectrogramPng != null, meta: analyzed.meta,
        }
      } finally { await input.cleanup() }
    } finally { release() }
  }

  return {
    analyzeOne: (ref, signal) => requests.run({
      key: mediaCacheKey(ref), signal,
      load: upstreamSignal => analyzeAndCache(ref, AbortSignal.any([upstreamSignal, AbortSignal.timeout(timeoutMs)])),
    }),
    cleanup: async () => {
      await deps.pools.rw.query(
        'DELETE FROM media_cache WHERE created_at < now() - make_interval(days => $1)',
        [deps.env.MEDIA_CACHE_MAX_AGE_DAYS],
      )
    },
    close: () => tarIndexes.close(),
  }
}
