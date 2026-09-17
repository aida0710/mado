import type { z } from 'zod'
import { PutReadmeOk, Readme, ReadmeHistoryList, ReadmeHistoryVersion, ReadmeSearchResult } from './types'
import { LONG_CACHE_TTL_MS, TTLCache } from './cache'
import { buildUrl, cacheKey, getJson, mutateJson, storagePath, type Revalidatable } from './http'

const readmeCache = new TTLCache<z.infer<typeof Readme>>(LONG_CACHE_TTL_MS, { persistKey: 'mado.cache.readme' })

// ディレクトリごとの README (S3 上の Markdown + DB のメタ) と、その履歴・検索。
export const readmeClient = {
  readme: (
    connectionId: string,
    bucket: string,
    prefix: string,
    opts: Revalidatable<z.infer<typeof Readme>> = {},
  ) =>
    readmeCache.get(
      cacheKey('readme', connectionId, bucket, prefix),
      () => getJson(buildUrl(storagePath(connectionId, '/readme'), { bucket, prefix }), Readme),
      opts.onRevalidate,
    ),

  invalidateReadme: (connectionId: string, bucket: string, prefix: string): void => {
    readmeCache.invalidate(cacheKey('readme', connectionId, bucket, prefix))
  },

  putReadme: async (
    connectionId: string,
    bucket: string,
    prefix: string,
    body: string,
    editor: string,
  ): Promise<z.infer<typeof PutReadmeOk>> => {
    const result = await mutateJson(
      storagePath(connectionId, '/readme'),
      { method: 'PUT', body: { bucket, prefix, body, editor } },
      PutReadmeOk,
    )
    // 編集後は当該 README のキャッシュを破棄。次回 readme() で最新を fetch。
    readmeCache.invalidate(cacheKey('readme', connectionId, bucket, prefix))
    return result
  },

  // README 編集履歴の一覧 (新しい順)。
  readmeHistory: (connectionId: string, bucket: string, prefix: string, limit?: number) =>
    getJson(buildUrl(storagePath(connectionId, '/readme/history'), {
      bucket, prefix, limit: limit != null ? String(limit) : undefined,
    }), ReadmeHistoryList),

  // 特定版の README 本文。
  readmeHistoryVersion: (connectionId: string, id: number) =>
    getJson(storagePath(connectionId, `/readme/history/${id}`), ReadmeHistoryVersion),

  // 接続内の README 全文検索 (現在版のみ対象)。
  readmesSearch: (connectionId: string, q: string, limit?: number) =>
    getJson(buildUrl(storagePath(connectionId, '/readmes/search'), {
      q, limit: limit != null ? String(limit) : undefined,
    }), ReadmeSearchResult),

  lastFetched: {
    readme: (connectionId: string, bucket: string, prefix: string): Date | null => {
      const at = readmeCache.getFetchedAt(cacheKey('readme', connectionId, bucket, prefix))
      return at != null ? new Date(at) : null
    },
  },
}
