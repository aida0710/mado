import { z } from 'zod'

export const HpcMetric = z.object({
  host: z.string(),
  command: z.string(),
  output: z.string(),
  collected_at: z.string().datetime(),
})
export type HpcMetric = z.infer<typeof HpcMetric>
export const HpcMetrics = z.array(HpcMetric)

export const Bucket = z.object({
  name: z.string(),
  creationDate: z.string().nullable(),
})
export const ListBuckets = z.object({
  buckets: z.array(Bucket),
})

export const S3File = z.object({
  key: z.string(),
  size: z.number(),
  lastModified: z.string().nullable(),
})
export const S3List = z.object({
  directories: z.array(z.string()),
  files: z.array(S3File),
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
