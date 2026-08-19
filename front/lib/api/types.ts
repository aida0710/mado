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
// nextStartAfter:   一部の S3 互換実装が NextContinuationToken を返さない
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
// 'v1':        ListObjectsV2 を理解しない古い S3 互換実装、
//              V1 only のサーバ向け。V2 を理解しないため ?start-after= が
//              無視され、毎回先頭ページが返ってきてしまう。s3cmd は元々 V1
//              を使うので動く。
export const ListObjectsVersion = z.enum(['v1', 'v2'])
export type ListObjectsVersion = z.infer<typeof ListObjectsVersion>

// 接続ごとに許可する操作 (api/storage.ts の Capabilities と 1:1)。
//
// 認証の無いツールなのでアクセス制御ではなく **誤操作の防止**。Glacier Deep
// Archive のように GetObject 自体が失敗する / 復元課金が発生するバケットや、
// 書き戻したくない本番バケットを登録した接続で、危険な導線を閉じるためにある。
// UI で隠すのは導線を消すためで、実際の遮断は API 側 (403) が担う。
export const Capabilities = z.object({
  list: z.boolean(),
  preview: z.boolean(),
  download: z.boolean(),
  archive: z.boolean(),
  audioInfo: z.boolean(),
  audioSpectrogram: z.boolean(),
  readmeRead: z.boolean(),
  readmeWrite: z.boolean(),
})
export type Capabilities = z.infer<typeof Capabilities>
export type Capability = keyof Capabilities

/** 全許可 — 新規接続の初期値であり、既定値そのもの
 *  (API 側も connection_settings に行が無ければ全許可を返す)。 */
export const ALL_CAPABILITIES_ON: Capabilities = {
  list: true, preview: true, download: true, archive: true,
  audioInfo: true, audioSpectrogram: true, readmeRead: true, readmeWrite: true,
}

/** 設定画面での表示順とラベル。api/lib/capabilityGuard.ts の
 *  CAPABILITY_LABELS と文言を揃えること (403 のメッセージに出る)。 */
export const CAPABILITY_UI: ReadonlyArray<{
  key: Capability
  label: string
  help: string
}> = [
  { key: 'list',             label: 'バケット / オブジェクトの一覧',
    help: '接続の基本機能。オフにするとこの接続では何も見られなくなります (完全に凍結したいとき用)。' },
  { key: 'preview',          label: 'ファイルのプレビュー (テキスト / 画像 / 音声)',
    help: 'ファイル本体を読みます。Deep Archive など GetObject が失敗する / 課金されるバケットではオフに。' },
  { key: 'download',         label: 'ファイルのダウンロード',
    help: '行メニューやプレビューの DL ボタン。オフにするとボタンが消え、共有 URL を直接叩いても 403 になります。' },
  { key: 'archive',          label: '圧縮ファイル (tar / tar.gz / tar.xz) を開く',
    help: '中身の一覧と個別エントリのプレビュー。tar.gz / tar.xz はアーカイブ全体を読むので重いです。' },
  { key: 'audioInfo',        label: '音声情報・波形の表示',
    help: 'ファイル全体をダウンロードして解析します。大きい音声が多い接続では負荷が大きくなります。' },
  { key: 'audioSpectrogram', label: 'スペクトログラムの表示',
    help: '「音声情報・波形」がオフのときは解析自体が走らないので、こちらも表示されません。' },
  { key: 'readmeRead',       label: 'README の読み込み',
    help: '各ディレクトリの README.md を S3 から読みます (Mado 側の DB ではなくバケットの実体)。' },
  { key: 'readmeWrite',      label: 'README の編集',
    help: 'README.md をバケットに書き戻します。読み込みがオフだと選べません。' },
]

export const Connection = z.object({
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  region: z.string(),
  accessKeyIdMasked: z.string(),
  forcePathStyle: z.boolean(),
  listObjectsVersion: ListObjectsVersion,
  capabilities: Capabilities,
  /** 配下の走査を許可するか。巨大バケットを抱える接続でのガード。 */
  scanEnabled: z.boolean(),
  /** 一覧キャッシュの保持秒数。既定 86400 (24 時間)。 */
  listCacheTtlSec: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isDefault: z.boolean(),
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
  capabilities: Capabilities
}

// PUT /api/internal/connections/:id — 部分更新。認証情報フィールドを省略すると既存の値が保持される。
// capabilities も差分 — 変えたキーだけ送る。
export interface ConnectionUpdateInput {
  name?: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle?: boolean
  listObjectsVersion?: ListObjectsVersion
  capabilities?: Partial<Capabilities>
  scanEnabled?: boolean
  listCacheTtlSec?: number
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

// 音声解析 (波形 / スペクトログラム)。GET /storage/:connId/media/analyze
// meta: ffprobe/ffmpeg の副産物 (コーデック・音量など)。旧 API 互換のため全体が null
// になり得る (各フィールドも個別に null 許容)。front/lib/audioInfo.ts で表示用に整形する。
export const MediaAnalyze = z.object({
  cacheKey: z.string(),
  peaks: z.array(z.tuple([z.number(), z.number()])),
  durationSec: z.number().nullable(),
  sampleRate: z.number().nullable(),
  hasSpectrogram: z.boolean(),
  meta: z.object({
    codec: z.string().nullable(),
    container: z.string().nullable(),
    channels: z.number().nullable(),
    bitsPerSample: z.number().nullable(),
    bitRate: z.number().nullable(),
    sizeBytes: z.number().nullable(),
    peakDb: z.number().nullable(),
    rmsDb: z.number().nullable(),
  }).nullable(),
})

// タグ (事前定義、全接続共通レジストリ)
export const Tag = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
})
export type Tag = z.infer<typeof Tag>
export const TagList = z.array(Tag)

export interface TagCreateInput { name: string; color: string }
export interface TagUpdateInput { name?: string; color?: string }

// bucket 自体 / ディレクトリ (prefix) / ファイル (key) — タグ割り当ての対象種別
export const TargetKind = z.enum(['bucket', 'prefix', 'file'])
export type TargetKind = z.infer<typeof TargetKind>

// バッチ取得: path → 割り当て済み tagId[]
export const TagAssignmentMap = z.record(z.string(), z.array(z.string()))

// 接続内横断検索のヒット 1 件
export const TagSearchHit = z.object({
  tagId: z.string(),
  bucket: z.string(),
  kind: TargetKind,
  path: z.string(),
})
export const TagSearchResult = z.array(TagSearchHit)
export type TagSearchResult = z.infer<typeof TagSearchResult>

// アプリ全体の設定。value は TEXT 固定で、型の解釈は呼び出し側の責務
// (boolean 以外の設定が増えてもスキーマを変えずに済ませるため)。
export const AppSettings = z.record(z.string(), z.string())
export type AppSettings = z.infer<typeof AppSettings>

// ── 走査ジョブ (spec: 2026-08-18-directory-scan-design.md) ──
export const ScanResult = z.object({
  objectCount: z.number(),
  totalBytes: z.number(),
  children: z.array(z.object({
    name: z.string(), objectCount: z.number(), totalBytes: z.number(),
  })),
  extensions: z.array(z.object({
    ext: z.string(), objectCount: z.number(), totalBytes: z.number(),
  })),
  partial: z.boolean(),
})
export type ScanResult = z.infer<typeof ScanResult>

// 進捗。総数が分からない処理があるので count と ratio の 2 形式を持つ。
// 走査は count (S3 に件数 API が無く、初回は分母が出せない)。
export const JobProgress = z.union([
  z.object({ kind: z.literal('count'), done: z.number(), label: z.string().optional() }),
  z.object({
    kind: z.literal('ratio'), done: z.number(), total: z.number(), label: z.string().optional(),
  }),
])

export const Job = z.object({
  id: z.number(),
  status: z.enum(['queued', 'running', 'done', 'error', 'canceled']),
  progress: JobProgress.nullable().optional(),
  result: z.unknown(),
  error: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
})
export type Job = z.infer<typeof Job>

export const StartScanOk = z.object({ jobId: z.number() })

