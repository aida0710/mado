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

  tarPreview: (bucket: string, key: string, limit = 200) =>
    getJson(buildUrl('/api/s3/preview/tar', {
      bucket,
      key,
      limit: String(limit),
    }), TarPreview),

  textPreviewUrl: (bucket: string, key: string): string =>
    buildUrl('/api/s3/preview/text', { bucket, key }),

  imageUrl: (bucket: string, key: string): string =>
    buildUrl('/api/s3/preview/image', { bucket, key }),

  audioUrl: (bucket: string, key: string): string =>
    buildUrl('/api/s3/preview/audio', { bucket, key }),

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
