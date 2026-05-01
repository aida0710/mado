import { z } from 'zod'

export const Metric = z.object({
  host: z.string(),
  command: z.string(),
  category: z.string(),
  output: z.string(),
  collected_at: z.string().datetime(),
})
export type Metric = z.infer<typeof Metric>
export const Metrics = z.array(Metric)

export const Bucket = z.object({
  name: z.string(),
  creationDate: z.string().nullable(),
})
export const ListBuckets = z.object({
  buckets: z.array(Bucket),
})

export const StorageFile = z.object({
  key: z.string(),
  size: z.number(),
  lastModified: z.string().nullable(),
})
export const StorageList = z.object({
  directories: z.array(z.string()),
  files: z.array(StorageFile),
  nextContinuation: z.string().nullable(),
})

export const ReadmeAbsent = z.object({ exists: z.literal(false) })
export const ReadmePresent = z.object({
  exists: z.literal(true),
  body: z.string(),
  last_editor: z.string().nullable(),
  last_edited_at: z.string().nullable(),
  size_bytes: z.number(),
})
export const Readme = z.union([ReadmeAbsent, ReadmePresent])

export const PutReadmeOk = z.object({
  ok: z.literal(true),
  meta_stale: z.boolean().optional(),
  size_bytes: z.number(),
})

export const TarPreview = z.object({
  entries: z.array(z.object({
    name: z.string(),
    size: z.number(),
    type: z.string(),
  })),
  truncated: z.boolean(),
  hasMore: z.boolean(),
  offset: z.number(),
  limit: z.number(),
})

export const FavoriteBuckets = z.array(z.string())

export const Connection = z.object({
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  region: z.string(),
  accessKeyIdMasked: z.string(),
  forcePathStyle: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Connection = z.infer<typeof Connection>

export const ConnectionList = z.array(Connection)

// What the form sends to POST /api/internal/connections.
// All fields required; secret/access key plaintext, transmitted over HTTP(S) on LAN.
export interface ConnectionCreateInput {
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

// PUT /api/internal/connections/:id — partial. Omit credential fields to keep the existing values.
export interface ConnectionUpdateInput {
  name?: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle?: boolean
}

export const NoteAbsent  = z.object({ exists: z.literal(false) })
export const NotePresent = z.object({
  exists: z.literal(true),
  body: z.string(),
  last_editor: z.string().nullable(),
  last_edited_at: z.string(),
})
export const Note = z.union([NoteAbsent, NotePresent])

export const PutNoteOk = z.object({ ok: z.literal(true) })

export const FeatureFlags = z.record(z.string(), z.boolean())
export type FeatureFlags = z.infer<typeof FeatureFlags>

export const SetFlagOk = z.object({
  ok: z.literal(true),
  name: z.string(),
  enabled: z.boolean(),
})
