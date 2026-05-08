import { z } from 'zod'

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
// nextContinuation: AWS 公式 S3 等で次ページ取得用の opaque トークン。
// nextStartAfter:   DDN 互換 S3 (mdx 等) が NextContinuationToken を返さない
//                   ときのフォールバック。最終キーを次ページの StartAfter に使う。
// 同時に両方 set されることはない (server 側で前者を優先)。
export const StorageList = z.object({
  directories: z.array(z.string()),
  files: z.array(StorageFile),
  nextContinuation: z.string().nullable(),
  nextStartAfter: z.string().nullable(),
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

// README 編集履歴 (一覧) - body は重いので含めない、選択時だけ取りに行く。
export const ReadmeHistoryListItem = z.object({
  id: z.number(),
  editor: z.string(),
  edited_at: z.string(),
  size_bytes: z.number(),
})
export const ReadmeHistoryList = z.object({
  versions: z.array(ReadmeHistoryListItem),
})

// 1 件の履歴 (body 含む)
export const ReadmeHistoryVersion = z.object({
  id: z.number(),
  bucket: z.string(),
  prefix: z.string(),
  body: z.string(),
  editor: z.string(),
  edited_at: z.string(),
  size_bytes: z.number(),
})

// 接続内 README 全文検索
export const ReadmeSearchHit = z.object({
  bucket: z.string(),
  prefix: z.string(),
  editor: z.string(),
  edited_at: z.string(),
  size_bytes: z.number(),
})
export const ReadmeSearchResult = z.object({
  hits: z.array(ReadmeSearchHit),
})

// Team notes (postgres notes テーブル) の編集履歴 — slug 単位、S3 README 履歴と並列。
export const NoteHistoryListItem = z.object({
  id: z.number(),
  editor: z.string(),
  edited_at: z.string(),
  size_bytes: z.number(),
})
export const NoteHistoryList = z.object({
  versions: z.array(NoteHistoryListItem),
})
export const NoteHistoryVersion = z.object({
  id: z.number(),
  slug: z.string(),
  body: z.string(),
  editor: z.string(),
  edited_at: z.string(),
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

// listObjectsVersion: 接続先 S3 サーバへの ListObjects API バージョン。
// 'v2' (既定): AWS / R2 / MinIO 等の正式な S3-compatible 実装向け。
// 'v1':        MDX (s3ds.mdx.jp) や古い NetApp StorageGRID 等の V1 only サーバ向け。
//              V2 を理解しないため ?start-after= が無視され、毎回先頭ページが
//              返ってきてしまう。s3cmd は元々 V1 を使うので動く。
export const ListObjectsVersion = z.enum(['v1', 'v2'])
export type ListObjectsVersion = z.infer<typeof ListObjectsVersion>

export const Connection = z.object({
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  region: z.string(),
  accessKeyIdMasked: z.string(),
  forcePathStyle: z.boolean(),
  listObjectsVersion: ListObjectsVersion,
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Connection = z.infer<typeof Connection>

export const ConnectionList = z.array(Connection)

// フォームが POST /api/internal/connections に送信するデータ。
// 全フィールド必須; シークレット/アクセスキーは平文で LAN 上の HTTP(S) で送信される。
export interface ConnectionCreateInput {
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
  listObjectsVersion: ListObjectsVersion
}

// PUT /api/internal/connections/:id — 部分更新。認証情報フィールドを省略すると既存の値が保持される。
export interface ConnectionUpdateInput {
  name?: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle?: boolean
  listObjectsVersion?: ListObjectsVersion
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
