import { HeadObjectCommand, type HeadObjectCommandOutput, type S3Client } from '@aws-sdk/client-s3'
import { TarRangeIndex } from './tar-range.js'
import { makeStorageRangeReader } from './storage-range-reader.js'
import { SharedRequests, RequestQueueFullError } from './shared-requests.js'

// ページ往復・シークに使う索引を、15分の未使用で破棄する。
const INDEX_IDLE_TTL_MS = 15 * 60 * 1000
const MAX_CACHED_ARCHIVES = 32
// sqliteのRAMではなく一時diskを制限する。本文の大きさには制限を掛けない。
const MAX_CACHE_DISK_BYTES = 2 * 1024 ** 3
// 連続するRange要求はHEADを共有し、本文GETのIfMatchで変更を検出する。
const HEAD_TTL_MS = 1000

interface CachedIndex {
  index: TarRangeIndex
  head: HeadObjectCommandOutput
  checkedAt: number
  signature: string
  lastUsedAt: number
  leases: number
}

export interface StorageTarIndex {
  index: TarRangeIndex
  size: number
  etag?: string
  release(): void
}

export class TarIndexCache {
  private readonly clientIds = new WeakMap<S3Client, number>()
  private nextClientId = 0
  private readonly archives = new Map<string, CachedIndex>()
  // 変更前の索引も、走査が終わるまでは同じ上限に数える。
  private readonly liveIndexes = new Set<CachedIndex>()
  private readonly heads = new SharedRequests<HeadObjectCommandOutput>()

  async open({ storage, bucket, key, signal }: {
    storage: S3Client; bucket: string; key: string; signal?: AbortSignal
  }): Promise<StorageTarIndex> {
    signal?.throwIfAborted()
    this.prune(Date.now())
    let clientId = this.clientIds.get(storage)
    if (clientId == null) { clientId = this.nextClientId++; this.clientIds.set(storage, clientId) }
    const archiveKey = JSON.stringify([clientId, bucket, key])
    const previous = this.archives.get(archiveKey)
    const head = previous?.head.ETag && Date.now() - previous.checkedAt < HEAD_TTL_MS
      ? previous.head
      : await this.heads.run({
        key: archiveKey, signal,
        load: upstreamSignal => storage.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: upstreamSignal }),
      })
    const size = head.ContentLength
    if (size == null || !Number.isSafeInteger(size) || size < 0) throw new Error('invalid tar object size')
    const signature = JSON.stringify([head.ETag, size, head.LastModified, head.VersionId])
    const now = Date.now()
    let cached = this.archives.get(archiveKey)
    if (!cached || cached.signature !== signature || (!head.ETag && cached.head !== head)) {
      if (cached) { this.archives.delete(archiveKey); this.retire(cached) }
      this.prune(now, 1)
      if (this.liveIndexes.size >= MAX_CACHED_ARCHIVES) throw new RequestQueueFullError()
      cached = {
        index: new TarRangeIndex(makeStorageRangeReader({ storage, bucket, key, size, etag: head.ETag })),
        head, signature, checkedAt: now, lastUsedAt: now, leases: 0,
      }
      this.liveIndexes.add(cached)
    }
    this.archives.delete(archiveKey)
    cached.head = head
    // cache hitで寿命を延ばすと更新を検出できなくなるため、実HEAD時刻だけを使う。
    if (head !== previous?.head) cached.checkedAt = now
    cached.lastUsedAt = now
    cached.leases++
    this.archives.set(archiveKey, cached)
    const leased = cached
    let released = false
    return {
      index: cached.index, size, etag: head.ETag,
      release: () => {
        if (released) return
        released = true
        leased.leases--
        if (this.archives.get(archiveKey) !== leased) this.retire(leased)
        this.prune(Date.now())
      },
    }
  }

  close(): void {
    for (const cached of this.archives.values()) this.retire(cached)
    this.archives.clear()
  }

  private retire(cached: CachedIndex): void {
    if (cached.leases > 0) return
    cached.index.close()
    this.liveIndexes.delete(cached)
  }

  private prune(now: number, reserve = 0): void {
    for (const [key, cached] of this.archives) {
      if (cached.leases === 0 && now - cached.lastUsedAt >= INDEX_IDLE_TTL_MS) {
        this.archives.delete(key)
        this.retire(cached)
      }
    }
    let bytes = [...this.liveIndexes].reduce((sum, cached) => sum + cached.index.diskBytes, 0)
    for (const [key, cached] of this.archives) {
      if (this.liveIndexes.size + reserve <= MAX_CACHED_ARCHIVES && bytes <= MAX_CACHE_DISK_BYTES) break
      if (cached.leases > 0) continue
      this.archives.delete(key)
      bytes -= cached.index.diskBytes
      this.retire(cached)
    }
  }
}
