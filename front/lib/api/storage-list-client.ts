import type { z } from 'zod'
import { ListBuckets, StorageList } from './types'
import { LONG_CACHE_TTL_MS, TTLCache } from './cache'
import { buildUrl, cacheKey, getJson, storagePath, type Revalidatable } from './http'

const listCache = new TTLCache<z.infer<typeof StorageList>>(LONG_CACHE_TTL_MS, {
  // v2: old persisted values have no authoritative server fetchedAt metadata.
  persistKey: 'mado.cache.list.v2',
  // A browser cache received near the end of the server TTL must not extend the
  // response another six hours. Revalidate no later than the server expiry.
  expiresAt: value => Date.parse(value.cache.expiresAt),
})
const bucketsCache = new TTLCache<z.infer<typeof ListBuckets>>(LONG_CACHE_TTL_MS, { persistKey: 'mado.cache.buckets' })

export interface ListCursor {
  continuation?: string
  startAfter?: string
}

const listCacheKey = (
  connectionId: string, bucket: string, prefix: string, recursive: boolean | undefined, cursor: ListCursor,
) => cacheKey('list', connectionId, bucket, prefix, recursive ? 'r' : '', cursor.continuation, cursor.startAfter)

// バケット一覧とディレクトリ一覧。上流が遅いので localStorage まで永続化する。
export const storageListClient = {
  buckets: (
    connectionId: string,
    opts: { refresh?: boolean } & Revalidatable<z.infer<typeof ListBuckets>> = {},
  ) =>
    bucketsCache.get(
      cacheKey('buckets', connectionId),
      () => getJson(
        buildUrl(storagePath(connectionId, '/buckets'), { refresh: opts.refresh ? '1' : undefined }),
        ListBuckets,
      ),
      opts.onRevalidate,
    ),

  invalidateBuckets: (connectionId: string): void => {
    bucketsCache.invalidate(cacheKey('buckets', connectionId))
  },

  list: (
    connectionId: string,
    bucket: string,
    prefix: string,
    cursor: ListCursor = {},
    opts: { recursive?: boolean; force?: boolean; refresh?: boolean }
      & Revalidatable<z.infer<typeof StorageList>> = {},
  ) => {
    // recursive フラグもキャッシュキーに含める (= 通常 list と再帰 list は別エントリ)。
    // prefix の後ろに置くので invalidateList の prefix-match invalidation はそのまま有効。
    const key = listCacheKey(connectionId, bucket, prefix, opts.recursive, cursor)
    // force=true は「forward navigation で同じ cache key に到達して停滞する」現象の防衛。
    // 一部の S3 互換実装は ContinuationToken / 最終キーを進めずに返してくることがあり、
    // そのとき同じ cursor で別ページを取りに行く想定の cache が衝突して前ページが返る。
    if (opts.force) listCache.invalidate(key)
    return listCache.get(
      key,
      () => getJson(buildUrl(storagePath(connectionId, '/list'), {
        bucket,
        prefix,
        continuation: cursor.continuation,
        startAfter: cursor.startAfter,
        recursive: opts.recursive ? '1' : undefined,
        refresh: opts.refresh ? '1' : undefined,
      }), StorageList),
      opts.onRevalidate,
    )
  },

  // 1 prefix のリスト全ページを破棄 (アップロード/削除や手動 refresh 後に呼ぶ)。
  invalidateList: (connectionId: string, bucket: string, prefix: string): void => {
    listCache.invalidatePrefix(cacheKey('list', connectionId, bucket, prefix))
  },

  // 該当キャッシュエントリが「いつ S3 から取得されたか」。null = 未取得 / 失敗 / invalidate 直後。
  // fetch 側と同じ引数で同じ cache key を組む。
  lastFetched: {
    list: (
      connectionId: string,
      bucket: string,
      prefix: string,
      cursor: ListCursor = {},
      opts: { recursive?: boolean } = {},
    ): Date | null => {
      const value = listCache.peek(listCacheKey(connectionId, bucket, prefix, opts.recursive, cursor))
      return value ? new Date(value.cache.fetchedAt) : null
    },
    buckets: (connectionId: string): Date | null => {
      const at = bucketsCache.getFetchedAt(cacheKey('buckets', connectionId))
      return at != null ? new Date(at) : null
    },
  },
}
