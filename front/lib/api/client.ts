import { z } from 'zod'
import {
  Connection,
  ConnectionList,
  FavoriteBuckets,
  FeatureFlags,
  Metrics,
  ListBuckets,
  Note,
  PutNoteOk,
  PutReadmeOk,
  Readme,
  SetFlagOk,
  StorageList,
  TarPreview,
} from './types'
import type { ConnectionCreateInput, ConnectionUpdateInput } from './types'

const API_BASE = '/api/internal'

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
    getJson(`${API_BASE}/storage/${encodeURIComponent(connId)}/buckets`, ListBuckets),

  list: (connId: string, bucket: string, prefix: string, continuation?: string | null) =>
    getJson(buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/list`, {
      bucket,
      prefix,
      continuation: continuation ?? undefined,
    }), StorageList),

  readme: (connId: string, bucket: string, prefix: string) =>
    getJson(buildUrl(`${API_BASE}/storage/${encodeURIComponent(connId)}/readme`, { bucket, prefix }), Readme),

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
    return PutReadmeOk.parse(json)
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
    getJson(`${API_BASE}/storage/${encodeURIComponent(connId)}/favorites`, FavoriteBuckets),

  addFavorite: async (connId: string, bucket: string): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/favorites/${encodeURIComponent(bucket)}`,
      { method: 'PUT' },
    )
    if (!res.ok) throw new Error(res.statusText)
  },

  removeFavorite: async (connId: string, bucket: string): Promise<void> => {
    const res = await fetch(
      `${API_BASE}/storage/${encodeURIComponent(connId)}/favorites/${encodeURIComponent(bucket)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error(res.statusText)
  },
}
