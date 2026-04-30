import { z } from 'zod'
import {
  FavoriteBuckets,
  HpcMetrics,
  ListBuckets,
  PutReadmeOk,
  Readme,
  S3List,
  TarPreview,
} from './types'

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
      /* non-JSON error body — keep statusText */
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

export const api = {
  hpc: () => getJson('/api/hpc', HpcMetrics),

  buckets: () => getJson('/api/s3/buckets', ListBuckets),

  list: (bucket: string, prefix: string, continuation?: string | null) =>
    getJson(buildUrl('/api/s3/list', {
      bucket,
      prefix,
      continuation: continuation ?? undefined,
    }), S3List),

  readme: (bucket: string, prefix: string) =>
    getJson(buildUrl('/api/s3/readme', { bucket, prefix }), Readme),

  putReadme: async (
    bucket: string,
    prefix: string,
    body: string,
    editor: string,
  ): Promise<z.infer<typeof PutReadmeOk>> => {
    const res = await fetch('/api/s3/readme', {
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
        /* keep statusText */
      }
      throw new Error(msg)
    }
    const json: unknown = await res.json()
    return PutReadmeOk.parse(json)
  },

  // Streams NDJSON. Lines are one of:
  //   {"mode":"range"|"stream"}
  //   {"entry":{name,size,type}}
  //   {"progress":{bytes,requests?}}
  //   {"done":{truncated,hasMore,offset,limit}}
  //   {"error":"..."}
  // Calls back per kind so the UI can show "X 件 / Y MB / mode" while the
  // stream is in flight, then resolves with the assembled TarPreview.
  tarPreview: async (
    bucket: string,
    key: string,
    opts: { limit?: number; offset?: number } = {},
    cb: {
      onMode?: (mode: 'range' | 'stream') => void
      onEntry?: (e: z.infer<typeof TarPreview>['entries'][number]) => void
      onProgress?: (p: { bytes: number; requests?: number }) => void
    } = {},
  ): Promise<z.infer<typeof TarPreview>> => {
    const url = buildUrl('/api/s3/preview/tar', {
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
        /* keep statusText */
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

  textPreviewUrl: (bucket: string, key: string): string =>
    buildUrl('/api/s3/preview/text', { bucket, key }),

  imageUrl: (bucket: string, key: string): string =>
    buildUrl('/api/s3/preview/image', { bucket, key }),

  audioUrl: (bucket: string, key: string): string =>
    buildUrl('/api/s3/preview/audio', { bucket, key }),

  // URL form for `<img src>` / `<audio src>` to a single tar entry's body.
  tarEntryUrl: (bucket: string, key: string, entry: string): string =>
    buildUrl('/api/s3/preview/tar-entry', { bucket, key, entry }),

  // Fetch the entry body as text. Throws on 4xx/5xx (entry not found, etc.).
  tarEntryText: async (
    bucket: string, key: string, entry: string,
  ): Promise<string> => {
    const res = await fetch(api.tarEntryUrl(bucket, key, entry))
    if (!res.ok) {
      let msg = res.statusText
      try {
        const j = (await res.json()) as { error?: string }
        if (j.error) msg = j.error
      } catch { /* keep statusText */ }
      throw new Error(msg)
    }
    return res.text()
  },

  favorites: () => getJson('/api/s3/favorites', FavoriteBuckets),

  addFavorite: async (bucket: string): Promise<void> => {
    const res = await fetch(
      `/api/s3/favorites/${encodeURIComponent(bucket)}`,
      { method: 'PUT' },
    )
    if (!res.ok) throw new Error(res.statusText)
  },

  removeFavorite: async (bucket: string): Promise<void> => {
    const res = await fetch(
      `/api/s3/favorites/${encodeURIComponent(bucket)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error(res.statusText)
  },
}
