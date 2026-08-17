import { z } from 'zod'
import {
  Connection,
  ConnectionList,
  FavoriteBuckets,
  ListBuckets,
  MediaAnalyze,
  Note,
  NoteHistoryList,
  NoteHistoryVersion,
  PutNoteOk,
  PutReadmeOk,
  Readme,
  ReadmeHistoryList,
  ReadmeHistoryVersion,
  ReadmeSearchResult,
  StorageList,
  Tag,
  TagAssignmentMap,
  TagList,
  TagSearchResult,
  AppSettings,
  TarPreview,
} from './types'
import type { ConnectionCreateInput, ConnectionUpdateInput, TagCreateInput, TagUpdateInput, TargetKind } from './types'
import { TTLCache } from './cache'

const API_BASE = '/api/internal'

// セッション内 (タブを開いている間) のレスポンスキャッシュ。
// S3 ディレクトリの行き来や preview の開閉でで毎回 fetch が走るのを抑える。
//
// 短 TTL (5 分) — in-memory のみ、永続化しない:
//   favorites: DB 由来で他端末からの toggle が概ね 5 分以内に見える。
//   tar:       一度プレビューすれば次は別アーカイブを見るユースケースが多く、
//              localStorage に貯める価値が薄い (容量も大きい)。in-flight dedup と
//              ページャ内の前後ボタン用にのみ in-memory cache を残す。
// 長 TTL (6 時間) — localStorage 永続化:
//   list / readme / buckets: MDX のレイテンシが 7〜24 秒と高く、ディレクトリ階層や
//              README の増減は緩いのでリロード越しのキャッシュ効果が大きい。
//   UI で「取得 HH:mm」を薄く表示してキャッシュ鮮度を可視化 (api.lastFetched.*)。
//   変更時は対応する invalidateXxx() を明示的に呼んで破棄する設計
//   (アップロード/削除/編集等のミューテーション + UI の 🔄 refresh ボタン)。
const CACHE_TTL_MS      = 5 * 60 * 1000
const LONG_CACHE_TTL_MS = 6 * 60 * 60 * 1000

const listCache            = new TTLCache<z.infer<typeof StorageList>>(LONG_CACHE_TTL_MS,    { persistKey: 'mado.cache.list' })
const readmeCache          = new TTLCache<z.infer<typeof Readme>>(LONG_CACHE_TTL_MS,         { persistKey: 'mado.cache.readme' })
const tarCache             = new TTLCache<z.infer<typeof TarPreview>>(CACHE_TTL_MS)
const bucketsCache         = new TTLCache<z.infer<typeof ListBuckets>>(LONG_CACHE_TTL_MS,    { persistKey: 'mado.cache.buckets' })
const favoritesCache       = new TTLCache<z.infer<typeof FavoriteBuckets>>(CACHE_TTL_MS)
const tagsCache            = new TTLCache<z.infer<typeof TagList>>(CACHE_TTL_MS)
const tagAssignmentsCache  = new TTLCache<z.infer<typeof TagAssignmentMap>>(CACHE_TTL_MS)

// 以前 tar も localStorage に永続化していたので、その残骸を起動時に一度だけ
// 掃除する。今のビルドはこのキーを読み書きしないため、放置しても害は無いが
// 容量を食うので消しておく。失敗しても無害なので silent。
if (typeof localStorage !== 'undefined') {
  try {
    const victims: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith('mado.cache.tar:')) victims.push(k)
    }
    for (const k of victims) localStorage.removeItem(k)
  } catch { /* silent */ }
}

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

  listConnections: () => getJson(`${API_BASE}/connections`, ConnectionList),

  createConnection: (input: ConnectionCreateInput) =>
    mutateJson(`${API_BASE}/connections`, { method: 'POST', body: input }, Connection),

  updateConnection: (id: string, input: ConnectionUpdateInput) =>
    mutateJson(`${API_BASE}/connections/${encodeURIComponent(id)}`, { method: 'PUT', body: input }, Connection),

  deleteConnection: (id: string) =>
    mutateJson(`${API_BASE}/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }, null),

  // デフォルト接続の切り替え。listConnections はキャッシュ層を通らないため
  // 呼び出し後の再取得だけで最新が見える。
  setDefaultConnection: async (id: string): Promise<void> => {
    await mutateJson(
      `${API_BASE}/connections/${encodeURIComponent(id)}/default`,
      { method: 'PUT' },
      z.object({ ok: z.boolean() }),
    )
  },

  buckets: (connId: string) =>
    bucketsCache.get(k('buckets', connId), () =>
      getJson(`${API_BASE}/storage/${encodeURIComponent(connId)}/buckets`, ListBuckets),
    ),

  invalidateBuckets: (connId: string): void => {
    bucketsCache.invalidate(k('buckets', connId))
  },

  list: (
    connId: string,
    bucket: string,
    prefix: string,
    cursor: { continuation?: string; startAfter?: string } = {},
    opts: { recursive?: boolean; force?: boolean } = {},
  ) => {
    // recursive フラグもキャッシュキーに含める (= 通常 list と再帰 list は別エントリ)。
    // prefix の後ろに置くので invalidateList の prefix-match invalidation はそのまま有効。
    const cacheKey = k('list', connId, bucket, prefix, opts.recursive ? 'r' : '', cursor.continuation, cursor.startAfter)
    // force=true は「forward navigation で同じ cache key に到達して停滞する」現象の防衛。
    // DDN 製などの S3 互換は ContinuationToken / 最終キーを進めずに返してくることがあり、
    // そのとき同じ cursor で別ページを取りに行く想定の cache が衝突して前ページが返る。
    if (opts.force) listCache.invalidate(cacheKey)
    return listCache.get(cacheKey, () =>
      getJson(buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/list`, {
        bucket,
        prefix,
        continuation: cursor.continuation,
        startAfter: cursor.startAfter,
        recursive: opts.recursive ? '1' : undefined,
      }), StorageList),
    )
  },

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

    const handleLine = (line: string): void => {
      if (line.length === 0) return
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

    while (true) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buf += dec.decode(value, { stream: true })
      // chunk ごとに分割: 最後の要素は incomplete 行なので buf に戻す。
      // 完了行 (\n 終端) のみを順に処理する。
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const line of parts) handleLine(line)
    }
    // closure (handleLine) 経由で代入するので TS は narrow できない。
    // ここまで来れば必ず DoneShape が入っていることを assert する。
    if (!done) throw new Error('tar stream ended without done marker')
    const finalDone: DoneShape = done
    return TarPreview.parse({ entries, ...finalDone })
    })
  },

  // URL の先頭 maxBytes だけ読み、残りは reader.cancel() で捨てる。
  //
  // /preview/tar-entry は Range 非対応で常に全量 (最大 100MB) を返す。テキストか
  // どうかを見るだけのために 100MB の npy を落としきるのは無駄なので、ストリームを
  // 途中で打ち切る。size を知らなくても安全なので、呼び出し側にサイズ上限の分岐が要らない。
  readHead: async (url: string, maxBytes: number): Promise<Uint8Array> => {
    const res = await fetch(url)
    if (!res.ok) {
      let msg = res.statusText
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) msg = body.error
      } catch { /* statusText をそのまま使う */ }
      throw new Error(msg)
    }
    // body が無い環境 (TS の型上 nullable) では stream を刻めない。せめて maxBytes で切る。
    if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, maxBytes)

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.length
      }
    } finally {
      // 既に done でも cancel は解決する。打ち切り時はここで残りの転送が止まる。
      await reader.cancel().catch(() => { /* 二重 cancel は無視 */ })
    }

    const out = new Uint8Array(Math.min(total, maxBytes))
    let offset = 0
    for (const c of chunks) {
      const take = Math.min(c.length, out.length - offset)
      out.set(c.subarray(0, take), offset)
      offset += take
    }
    return out
  },

  textPreviewUrl: (connId: string, bucket: string, key: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/text`, { bucket, key }),

  imageUrl: (connId: string, bucket: string, key: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/image`, { bucket, key }),

  audioUrl: (connId: string, bucket: string, key: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/audio`, { bucket, key }),

  // 音声解析 (波形ピーク + スペクトログラム有無)。サーバー側でキャッシュされる
  // ため TTLCache には入れない。長尺ファイルはレスポンスまで数十秒かかりうる —
  // 呼び出し側は AbortSignal でアンマウント時に中断すること。
  mediaAnalyze: async (
    connId: string,
    bucket: string,
    key: string,
    opts: { entryPath?: string; signal?: AbortSignal } = {},
  ) => {
    const url = buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/media/analyze`, {
      bucket, key, entryPath: opts.entryPath,
    })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: opts.signal,
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const body = (await res.json()) as { error?: string }
        if (body.error) msg = body.error
      } catch { /* statusText をそのまま使う */ }
      throw new Error(msg)
    }
    return MediaAnalyze.parse(await res.json())
  },

  spectrogramUrl: (connId: string, cacheKey: string): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/media/spectrogram`, { cacheKey }),

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
  //
  // opts.maxBytes を渡すと、サーバーはエントリの先頭 maxBytes だけを抽出して返す
  // (head モード)。テキストかどうか見るだけの用途で 100MB のエントリを丸ごと
  // 解凍させないために使う。**<img src> / <audio src> / ダウンロードでは付けないこと**
  // — 本体が途中で切れる。
  tarEntryUrl: (
    connId: string, bucket: string, key: string, entry: string,
    opts: { maxBytes?: number } = {},
  ): string =>
    buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/preview/tar-entry`, {
      bucket, key, entry,
      maxBytes: opts.maxBytes != null ? String(opts.maxBytes) : undefined,
    }),

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

  tags: () => tagsCache.get('tags', () => getJson(`${API_BASE}/tags`, TagList)),

  invalidateTags: (): void => { tagsCache.invalidate('tags') },

  createTag: async (input: TagCreateInput): Promise<z.infer<typeof Tag>> => {
    const t = await mutateJson(`${API_BASE}/tags`, { method: 'POST', body: input }, Tag)
    tagsCache.invalidate('tags')
    return t
  },

  updateTag: async (id: string, input: TagUpdateInput): Promise<z.infer<typeof Tag>> => {
    const t = await mutateJson(`${API_BASE}/tags/${encodeURIComponent(id)}`, { method: 'PUT', body: input }, Tag)
    tagsCache.invalidate('tags')
    return t
  },

  deleteTag: async (id: string): Promise<void> => {
    await mutateJson(`${API_BASE}/tags/${encodeURIComponent(id)}`, { method: 'DELETE' }, null)
    tagsCache.invalidate('tags')
  },

  // 一覧をまとめて hydrate するバッチ取得。paths が空なら fetch しない
  // (呼び出し側が dirs/files 0 件のときに空 URL を叩かないための短絡)。
  tagAssignments: (
    connId: string, bucket: string, kind: TargetKind, paths: string[],
  ): Promise<z.infer<typeof TagAssignmentMap>> => {
    if (paths.length === 0) return Promise.resolve({})
    const cacheKey = k('tagAssignments', connId, bucket, kind, ...paths)
    return tagAssignmentsCache.get(cacheKey, () => {
      const search = new URLSearchParams({ bucket, kind })
      for (const p of paths) search.append('paths', p)
      return getJson(
        `${API_BASE}/storage/${encodeURIComponent(connId)}/tags?${search.toString()}`,
        TagAssignmentMap,
      )
    })
  },

  invalidateTagAssignments: (connId: string, bucket: string, kind: TargetKind): void => {
    tagAssignmentsCache.invalidatePrefix(k('tagAssignments', connId, bucket, kind))
  },

  assignTag: async (
    connId: string, bucket: string, kind: TargetKind, path: string, tagId: string,
  ): Promise<void> => {
    await mutateJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/tags`,
      { method: 'PUT', body: { bucket, kind, path, tagId } },
      null,
    )
    tagAssignmentsCache.invalidatePrefix(k('tagAssignments', connId, bucket, kind))
  },

  unassignTag: async (
    connId: string, bucket: string, kind: TargetKind, path: string, tagId: string,
  ): Promise<void> => {
    await mutateJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/tags`,
      { method: 'DELETE', body: { bucket, kind, path, tagId } },
      null,
    )
    tagAssignmentsCache.invalidatePrefix(k('tagAssignments', connId, bucket, kind))
  },

  // 同一接続内の全バケットを横断して、選んだタグのいずれかが付いた対象を返す。
  tagSearch: (connId: string, tagIds: string[]): Promise<z.infer<typeof TagSearchResult>> => {
    const search = new URLSearchParams()
    for (const id of tagIds) search.append('tagId', id)
    return getJson(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/tags/search?${search.toString()}`,
      TagSearchResult,
    )
  },

  // アプリ全体の設定。個別キーではなく全件を 1 回で取る (設定が増えても
  // 画面表示時のラウンドトリップを増やさないため)。キャッシュは持たない —
  // Settings で切り替えた結果が次の画面遷移で即反映されてほしいので。
  settings: (): Promise<z.infer<typeof AppSettings>> =>
    getJson(`${API_BASE}/settings`, AppSettings),

  putSetting: async (key: string, value: string): Promise<void> => {
    await mutateJson(`${API_BASE}/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } }, null)
  },

  // 該当キャッシュエントリが「いつ S3 から取得されたか」を Date で返す。
  // null = まだ取得していない / 取得失敗 / invalidate された直後。
  // UI で「取得 HH:mm」を薄く表示してキャッシュ鮮度をユーザに見せるのに使う。
  // 各メソッドは対応する fetch メソッドと同じ引数を取って同じ cache key を組み立てる。
  lastFetched: {
    list: (
      connId: string,
      bucket: string,
      prefix: string,
      cursor: { continuation?: string; startAfter?: string } = {},
      opts: { recursive?: boolean } = {},
    ): Date | null => {
      const cacheKey = k('list', connId, bucket, prefix, opts.recursive ? 'r' : '', cursor.continuation, cursor.startAfter)
      const at = listCache.getFetchedAt(cacheKey)
      return at != null ? new Date(at) : null
    },
    readme: (connId: string, bucket: string, prefix: string): Date | null => {
      const at = readmeCache.getFetchedAt(k('readme', connId, bucket, prefix))
      return at != null ? new Date(at) : null
    },
    tar: (
      connId: string,
      bucket: string,
      key: string,
      opts: { limit?: number; offset?: number } = {},
    ): Date | null => {
      const at = tarCache.getFetchedAt(k('tar', connId, bucket, key, opts.offset ?? 0, opts.limit ?? 0))
      return at != null ? new Date(at) : null
    },
    buckets: (connId: string): Date | null => {
      const at = bucketsCache.getFetchedAt(k('buckets', connId))
      return at != null ? new Date(at) : null
    },
  },
}
