import { z } from 'zod'
import {
  Connection,
  ConnectionList,
  FavoriteBuckets,
  FeatureFlags,
  Metrics,
  ListBuckets,
  Note,
  NoteHistoryList,
  NoteHistoryVersion,
  PutNoteOk,
  PutReadmeOk,
  Readme,
  ReadmeHistoryList,
  ReadmeHistoryVersion,
  ReadmeSearchResult,
  SetFlagOk,
  StorageList,
  TarPreview,
} from './types'
import type { ConnectionCreateInput, ConnectionUpdateInput } from './types'
import { TTLCache } from './cache'

const API_BASE = '/api/internal'

// セッション内 (タブを開いている間) のレスポンスキャッシュ。
// S3 ディレクトリの行き来や preview の開閉でで毎回 fetch が走るのを抑える。
//
// TTL は 5 分: 「同じファイルをすぐ見直す」ユースケースを吸収しつつ、
// 他人がアップロードした変更も次の 5 分で見える。明示的に最新化したいときは
// UI の 🔄 refresh ボタンが invalidate を呼ぶ。
const CACHE_TTL_MS = 5 * 60 * 1000

const listCache      = new TTLCache<z.infer<typeof StorageList>>(CACHE_TTL_MS)
const readmeCache    = new TTLCache<z.infer<typeof Readme>>(CACHE_TTL_MS)
const tarCache       = new TTLCache<z.infer<typeof TarPreview>>(CACHE_TTL_MS)
const bucketsCache   = new TTLCache<z.infer<typeof ListBuckets>>(CACHE_TTL_MS)
const favoritesCache = new TTLCache<z.infer<typeof FavoriteBuckets>>(CACHE_TTL_MS)

// キャッシュキー作成。'|' は S3 のキー / prefix では出現しないため衝突しない。
const k = (...parts: Array<string | number | null | undefined>): string =>
  parts.map(p => p ?? '').join('|')

async function getJson<T extends z.ZodTypeAny>(
  url: string,
  schema: T,
): Promise<z.infer<T>> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) msg = body.error
    } catch {
      /* JSON でないエラーボディ — statusText をそのまま使う */
    }
    throw new Error(msg)
  }
  const json: unknown = await res.json()
  return schema.parse(json)
}

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, v)
  }
  const qs = search.toString()
  return qs ? `${path}?${qs}` : path
}

async function mutateJson<T extends z.ZodTypeAny>(
  url: string,
  init: { method: 'POST' | 'PUT' | 'DELETE'; body?: unknown },
  schema: T | null,
): Promise<T extends z.ZodTypeAny ? z.infer<T> : void> {
  const res = await fetch(url, {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) msg = body.error
    } catch { /* statusText をそのまま使う */ }
    throw new Error(msg)
  }
  if (schema === null) return undefined as never
  const json: unknown = await res.json()
  return schema.parse(json) as never
}

export const api = {
  metrics: () => getJson(`${API_BASE}/metrics`, Metrics),

  note: (slug: string) =>
    getJson(`${API_BASE}/notes/${encodeURIComponent(slug)}`, Note),

  putNote: async (
    slug: string,
    body: string,
    editor: string,
  ): Promise<z.infer<typeof PutNoteOk>> => {
    const res = await fetch(`${API_BASE}/notes/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, editor }),
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const e = (await res.json()) as { error?: string }
        if (e.error) msg = e.error
      } catch { /* statusText をそのまま使う */ }
      throw new Error(msg)
    }
    return PutNoteOk.parse(await res.json())
  },

  flags: () => getJson(`${API_BASE}/settings/flags`, FeatureFlags),

  setFlag: (name: string, enabled: boolean) =>
    mutateJson(
      `${API_BASE}/settings/flags/${encodeURIComponent(name)}`,
      { method: 'PUT', body: { enabled } },
      SetFlagOk,
    ),

  listConnections: () => getJson(`${API_BASE}/connections`, ConnectionList),

  createConnection: (input: ConnectionCreateInput) =>
    mutateJson(`${API_BASE}/connections`, { method: 'POST', body: input }, Connection),

  updateConnection: (id: string, input: ConnectionUpdateInput) =>
    mutateJson(`${API_BASE}/connections/${encodeURIComponent(id)}`, { method: 'PUT', body: input }, Connection),

  deleteConnection: (id: string) =>
    mutateJson(`${API_BASE}/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }, null),

  buckets: (connId: string) =>
    bucketsCache.get(k('buckets', connId), () =>
      getJson(`${API_BASE}/storage/${encodeURIComponent(connId)}/buckets`, ListBuckets),
    ),

  invalidateBuckets: (connId: string): void => {
    bucketsCache.invalidate(k('buckets', connId))
  },

  list: (connId: string, bucket: string, prefix: string, cursor: { continuation?: string; startAfter?: string } = {}) =>
    listCache.get(k('list', connId, bucket, prefix, cursor.continuation, cursor.startAfter), () =>
      getJson(buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/list`, {
        bucket,
        prefix,
        continuation: cursor.continuation,
        startAfter: cursor.startAfter,
      }), StorageList),
    ),

  // 1 prefix のリスト全ページを破棄 (アップロード/削除や手動 refresh 後に呼ぶ)。
  invalidateList: (connId: string, bucket: string, prefix: string): void => {
    listCache.invalidatePrefix(k('list', connId, bucket, prefix))
  },

  readme: (connId: string, bucket: string, prefix: string) =>
    readmeCache.get(k('readme', connId, bucket, prefix), () =>
      getJson(buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/readme`, { bucket, prefix }), Readme),
    ),

  invalidateReadme: (connId: string, bucket: string, prefix: string): void => {
    readmeCache.invalidate(k('readme', connId, bucket, prefix))
  },

  putReadme: async (
    connId: string,
    bucket: string,
    prefix: string,
    body: string,
    editor: string,
  ): Promise<z.infer<typeof PutReadmeOk>> => {
    const res = await fetch(`${API_BASE}/storage/${encodeURIComponent(connId)}/readme`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bucket, prefix, body, editor }),
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const errBody = (await res.json()) as { error?: string }
        if (errBody.error) msg = errBody.error
      } catch {
        /* statusText をそのまま使う */
      }
      throw new Error(msg)
    }
    const json: unknown = await res.json()
    // 編集後は当該 README のキャッシュを破棄。次回 readme() で最新を fetch。
    readmeCache.invalidate(k('readme', connId, bucket, prefix))
    return PutReadmeOk.parse(json)
  },

  // 1 アーカイブの全ページを破棄 (手動 refresh などから呼ぶ)。
  invalidateTarPreview: (connId: string, bucket: string, key: string): void => {
    tarCache.invalidatePrefix(k('tar', connId, bucket, key))
  },

  // NDJSON をストリーミングする。各行は以下のいずれか:
  //   {"mode":"range"|"stream"}
  //   {"entry":{name,size,type}}
  //   {"progress":{bytes,requests?}}
  //   {"done":{truncated,hasMore,offset,limit}}
  //   {"error":"..."}
  // 種別ごとにコールバックするため、ストリーム中に UI が「X 件 / Y MB / mode」を
  // 表示でき、最終的に組み立てた TarPreview で解決する。
  tarPreview: async (
    connId: string,
    bucket: string,
    key: string,
    opts: { limit?: number; offset?: number } = {},
    cb: {
      onMode?: (mode: 'range' | 'stream') => void
      onEntry?: (e: z.infer<typeof TarPreview>['entries'][number]) => void
      onProgress?: (p: { bytes: number; requests?: number }) => void
    } = {},
  ): Promise<z.infer<typeof TarPreview>> => {
    // (offset, limit) 単位でキャッシュ。同じページを再表示しても再 download しない。
    // tar.gz / tar.xz は 1 ページめくるたびにアーカイブ全体を再 download/decode
    // しているので効果が大きい。コールバック (onMode/onEntry/onProgress) は
    // キャッシュヒット時には呼ばれない (= 進捗 UI が出ないが、瞬時に終わる)。
    const cacheKey = k('tar', connId, bucket, key, opts.offset ?? 0, opts.limit ?? 0)
    return tarCache.get(cacheKey, async () => {
    const url = buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/tar`, {
      bucket,
      key,
      limit:  opts.limit  != null ? String(opts.limit)  : undefined,
      offset: opts.offset != null ? String(opts.offset) : undefined,
    })
    const res = await fetch(url)
    if (!res.ok) {
      let msg = res.statusText
      try {
        const errBody = (await res.json()) as { error?: string }
        if (errBody.error) msg = errBody.error
      } catch {
        /* statusText をそのまま使う */
      }
      throw new Error(msg)
    }
    interface DoneShape {
      truncated: boolean
      hasMore: boolean
      offset: number
      limit: number
    }
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    const entries: z.infer<typeof TarPreview>['entries'] = []
    let done: DoneShape | null = null
    let buf = ''

    while (true) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buf += dec.decode(value, { stream: true })
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.length > 0) {
          const obj = JSON.parse(line) as Record<string, unknown>
          if ('mode' in obj) {
            cb.onMode?.(obj.mode as 'range' | 'stream')
          } else if ('entry' in obj) {
            const entry = obj.entry as { name: string; size: number; type: string }
            entries.push(entry)
            cb.onEntry?.(entry)
          } else if ('progress' in obj) {
            cb.onProgress?.(obj.progress as { bytes: number; requests?: number })
          } else if ('done' in obj) {
            done = obj.done as DoneShape
          } else if ('error' in obj) {
            throw new Error(String(obj.error))
          }
        }
        nl = buf.indexOf('\n')
      }
    }
    if (!done) throw new Error('tar stream ended without done marker')
    return TarPreview.parse({ entries, ...done })
    })
  },

  textPreviewUrl: (connId: string, bucket: string, key: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/text`, { bucket, key }),

  imageUrl: (connId: string, bucket: string, key: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/image`, { bucket, key }),

  audioUrl: (connId: string, bucket: string, key: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/audio`, { bucket, key }),

  // 任意のキーをそのままダウンロードする URL。バックエンドが
  // Content-Disposition: attachment を付けるためブラウザはファイル保存を促す。
  downloadUrl: (connId: string, bucket: string, key: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/raw`, { bucket, key }),

  // README 編集履歴の一覧 (新しい順)。
  readmeHistory: (connId: string, bucket: string, prefix: string, limit?: number) =>
    getJson(buildUrl(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/readme/history`,
      { bucket, prefix, limit: limit != null ? String(limit) : undefined },
    ), ReadmeHistoryList),

  // 特定版の README 本文。
  readmeHistoryVersion: (connId: string, id: number) =>
    getJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/readme/history/${id}`,
      ReadmeHistoryVersion,
    ),

  // 接続内の README 全文検索 (現在版のみ対象)。
  readmesSearch: (connId: string, q: string, limit?: number) =>
    getJson(buildUrl(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/readmes/search`,
      { q, limit: limit != null ? String(limit) : undefined },
    ), ReadmeSearchResult),

  // Team note (postgres) の編集履歴。
  noteHistory: (slug: string, limit?: number) =>
    getJson(buildUrl(
      `${API_BASE}/notes/${encodeURIComponent(slug)}/history`,
      { limit: limit != null ? String(limit) : undefined },
    ), NoteHistoryList),

  noteHistoryVersion: (slug: string, id: number) =>
    getJson(
      `${API_BASE}/notes/${encodeURIComponent(slug)}/history/${id}`,
      NoteHistoryVersion,
    ),

  // `<img src>` / `<audio src>` 用の tar エントリ本体への URL 形式。
  tarEntryUrl: (connId: string, bucket: string, key: string, entry: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/tar-entry`, { bucket, key, entry }),

  // エントリ本体をテキストとしてフェッチする。4xx/5xx (エントリが見つからない等) で例外を投げる。
  tarEntryText: async (
    connId: string, bucket: string, key: string, entry: string,
  ): Promise<string> => {
    const res = await fetch(api.tarEntryUrl(connId, bucket, key, entry))
    if (!res.ok) {
      let msg = res.statusText
      try {
        const j = (await res.json()) as { error?: string }
        if (j.error) msg = j.error
      } catch { /* statusText をそのまま使う */ }
      throw new Error(msg)
    }
    return res.text()
  },

  favorites: (connId: string) =>
    favoritesCache.get(k('favorites', connId), () =>
      getJson(`${API_BASE}/storage/${encodeURIComponent(connId)}/favorites`, FavoriteBuckets),
    ),

  invalidateFavorites: (connId: string): void => {
    favoritesCache.invalidate(k('favorites', connId))
  },

  addFavorite: async (connId: string, bucket: string): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/favorites/${encodeURIComponent(bucket)}`,
      { method: 'PUT' },
    )
    if (!res.ok) throw new Error(res.statusText)
    favoritesCache.invalidate(k('favorites', connId))
  },

  removeFavorite: async (connId: string, bucket: string): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/favorites/${encodeURIComponent(bucket)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error(res.statusText)
    favoritesCache.invalidate(k('favorites', connId))
  },
}
