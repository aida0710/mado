import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { TarRangeIndex } from './tar-range.js'
import { makeStorageRangeReader } from './storage-range-reader.js'

// ページの往復と再生中のシークに使い、15分使われなかった索引は次の取得時に捨てる。
const INDEX_IDLE_TTL_MS = 15 * 60 * 1000
// 同時に使う32アーカイブまで残し、それ以上は古い索引から捨てる。
const MAX_CACHED_ARCHIVES = 32
// 大量の小ファイルがあるtarで索引だけが増え続けないよう、保存件数も制限する。
const MAX_CACHED_ENTRIES = 100_000

interface CachedIndex {
  index: TarRangeIndex
  signature: string
  lastUsedAt: number
}

export interface StorageTarIndex {
  index: TarRangeIndex
  size: number
  etag?: string
}

/** S3クライアントごとに索引を分け、毎回HEADでオブジェクトの変更を確認する。 */
export class TarIndexCache {
  private readonly clients = new WeakMap<S3Client, Map<string, CachedIndex>>()

  async open({ storage, bucket, key, signal }: {
    storage: S3Client
    bucket: string
    key: string
    signal?: AbortSignal
  }): Promise<StorageTarIndex> {
    const head = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal })
    const size = head.ContentLength
    if (size == null || !Number.isSafeInteger(size) || size < 0) throw new Error('invalid tar object size')
    const signature = JSON.stringify([head.ETag, size, head.LastModified, head.VersionId])
    let archives = this.clients.get(storage)
    if (!archives) {
      archives = new Map()
      this.clients.set(storage, archives)
    }
    const now = Date.now()
    this.prune(archives, now)
    const archiveKey = JSON.stringify([bucket, key])
    let cached = archives.get(archiveKey)
    if (!cached || cached.signature !== signature) {
      cached = {
        index: new TarRangeIndex(makeStorageRangeReader({ storage, bucket, key, size, etag: head.ETag })),
        signature, lastUsedAt: now,
      }
    }
    // Mapの順序を最終使用順にし、古い索引から捨てる。
    archives.delete(archiveKey)
    cached.lastUsedAt = now
    archives.set(archiveKey, cached)
    this.prune(archives, now)
    return { index: cached.index, size, etag: head.ETag }
  }

  private prune(archives: Map<string, CachedIndex>, now: number): void {
    let entries = 0
    for (const [key, cached] of archives) {
      if (now - cached.lastUsedAt >= INDEX_IDLE_TTL_MS) archives.delete(key)
      else entries += cached.index.entryCount
    }
    for (const [key, cached] of archives) {
      if (archives.size <= MAX_CACHED_ARCHIVES && entries <= MAX_CACHED_ENTRIES) break
      archives.delete(key)
      entries -= cached.index.entryCount
    }
  }
}
