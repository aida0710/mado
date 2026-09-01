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

// ── 転送見積もりのプロファイル (spec: 2026-08-22-transfer-estimate-design.md) ──

export const Provider = z.enum(['aws', 'wasabi', 'onprem', 'other'])
export type Provider = z.infer<typeof Provider>

export const PROVIDER_LABELS: Record<Provider, string> = {
  aws:    'AWS S3',
  wasabi: 'Wasabi',
  onprem: '社内 / その他 (費用なし)',
  other:  'その他',
}

export const StorageClassKey = z.enum([
  'STANDARD', 'INTELLIGENT_TIERING', 'STANDARD_IA', 'ONEZONE_IA',
  'GLACIER_IR', 'GLACIER', 'DEEP_ARCHIVE',
])
export type StorageClassKey = z.infer<typeof StorageClassKey>

/** 選択肢の並び。「速くて高い」→「遅くて安い」の順に並べる。 */
export const STORAGE_CLASS_OPTIONS: Array<{ key: StorageClassKey; label: string; help: string }> = [
  { key: 'STANDARD',            label: 'Standard',
    help: '既定。取り出し料金も最小保存期間も無い。' },
  { key: 'INTELLIGENT_TIERING', label: 'Intelligent-Tiering',
    help: 'アクセス頻度で自動的に階層を移す。オブジェクトごとに監視料がかかる。' },
  { key: 'STANDARD_IA',         label: 'Standard-IA',
    help: '月額は約半分。読み出しに $/GB がかかり、最小 30 日・128KB 単位。' },
  { key: 'ONEZONE_IA',          label: 'One Zone-IA',
    help: '1 つの AZ にしか置かない。失っても再生成できるデータ向け。' },
  { key: 'GLACIER_IR',          label: 'Glacier Instant Retrieval',
    help: '取り出しは即時だが $/GB が高い。最小 90 日。' },
  { key: 'GLACIER',             label: 'Glacier Flexible Retrieval',
    help: '取り出しに数分〜数時間。最小 90 日。' },
  { key: 'DEEP_ARCHIVE',        label: 'Glacier Deep Archive',
    help: '最安。取り出しに十数時間かかり、最小 180 日。' },
]

/** 接続ごとの見積もり設定。値は「設定 + 推定 + 既定」を畳んだ実効値。 */
export const ConnectionPricing = z.object({
  provider: Provider,
  /** false = エンドポイントからの自動判定。 */
  providerExplicit: z.boolean(),
  region: z.string().nullable(),
  storageClass: StorageClassKey.nullable(),
  storageClassLabel: z.string().nullable(),
  /** false = 料金カタログに単価が無い。費用 0 は「無料」の意味ではない。 */
  ratesResolved: z.boolean(),
  readMbps: z.number(),
  writeMbps: z.number(),
  parallelism: z.number(),
  requestOverheadMs: z.number(),
  instability: z.number(),
  capacityBytes: z.number().nullable(),
  // 手動上書き。null = カタログに従う。
  storagePerGbMonth: z.number().nullable(),
  egressPerGb: z.number().nullable(),
  putPer1000: z.number().nullable(),
  getPer1000: z.number().nullable(),
  /** 上書き適用後の実効単価 (「今いくらで計算されるか」の表示用)。 */
  effective: z.object({
    storagePerGbMonth: z.number().nullable(),
    egressPerGb: z.number().nullable(),
    putPer1000: z.number(),
    getPer1000: z.number(),
    retrievalPerGb: z.number(),
    minDurationDays: z.number(),
    minBillableBytes: z.number(),
    /** オブジェクトごとに加算されるバイト数 (Glacier 系の 40KB)。 */
    perObjectOverheadBytes: z.number(),
    /** 単価の出所。'manual' は「単価を更新しても変わらない」。 */
    storageRateSource: z.enum(['api', 'proxy', 'manual', 'override', 'none']),
  }),
})
export type ConnectionPricing = z.infer<typeof ConnectionPricing>

export const ConnectionAccessUser = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(['active', 'disabled']),
})
export type ConnectionAccessUser = z.infer<typeof ConnectionAccessUser>
export const ConnectionAccessUsers = z.object({ users: z.array(ConnectionAccessUser) })

export const ConnectionVisibility = z.object({
  mode: z.enum(['public', 'whitelist']),
  allowedUsers: z.array(ConnectionAccessUser),
})
export type ConnectionVisibility = z.infer<typeof ConnectionVisibility>

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
  /** 転送見積もりに使うプロファイル。 */
  pricing: ConnectionPricing,
  createdAt: z.string(),
  updatedAt: z.string(),
  isDefault: z.boolean(),
  visibility: ConnectionVisibility.default({ mode: 'public', allowedUsers: [] }),
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
  visibility?: { mode: 'public' | 'whitelist'; allowedUserIds: string[] }
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
  visibility?: { mode?: 'public' | 'whitelist'; allowedUserIds?: string[] }
  scanEnabled?: boolean
  listCacheTtlSec?: number
  /** 見積もり設定の差分。**null = 既定に戻す** (設定行を消す)、
   *  未指定 = 触らない。プロバイダの既定が「エンドポイントから推定」なので
   *  この区別が要る。 */
  pricing?: ConnectionPricingInput
}

export interface ConnectionPricingInput {
  provider?: Provider | null
  region?: string | null
  storageClass?: StorageClassKey | null
  readMbps?: number | null
  writeMbps?: number | null
  parallelism?: number | null
  requestOverheadMs?: number | null
  instability?: number | null
  capacityBytes?: number | null
  storagePerGbMonth?: number | null
  egressPerGb?: number | null
  putPer1000?: number | null
  getPer1000?: number | null
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

/** ジョブ投入の応答。走査も単価更新も同じ形。 */
export const StartJobOk = z.object({ jobId: z.number() })
export const StartScanOk = StartJobOk

// ── 転送見積もり (spec: 2026-08-22-transfer-estimate-design.md) ──

// kind は増える前提なので enum にしない。増えた警告が parse エラーで
// 画面を落とすより、知らない kind でもメッセージを出せる方がよい。
export const EstimateWarning = z.object({
  kind: z.string(),
  message: z.string(),
})
export type EstimateWarning = z.infer<typeof EstimateWarning>

export const TransferCandidate = z.object({
  connId: z.string(),
  name: z.string(),
  provider: Provider,
  storageClass: StorageClassKey.nullable(),
  storageClassLabel: z.string().nullable(),
  /** 移動元と同じ接続 (= ストレージクラスの変更)。回線も egress も要らない。 */
  sameConnection: z.boolean(),
  durationSec: z.object({ optimistic: z.number(), pessimistic: z.number() }),
  upfront: z.object({
    egress: z.number(),
    retrieval: z.number(),
    getRequests: z.number(),
    putRequests: z.number(),
    total: z.number(),
  }),
  monthlyUsd: z.number(),
  billableBytes: z.number(),
  putRequestCount: z.number(),
  avgObjectBytes: z.number(),
  warnings: z.array(EstimateWarning),
})
export type TransferCandidate = z.infer<typeof TransferCandidate>

export const TransferEstimate = z.object({
  source: z.object({
    connId: z.string(),
    name: z.string(),
    provider: Provider,
    storageClass: StorageClassKey.nullable(),
    storageClassLabel: z.string().nullable(),
  }),
  scan: z.object({
    objectCount: z.number(),
    totalBytes: z.number(),
    scannedAt: z.string().nullable(),
  }),
  catalog: z.object({
    asOf: z.string(),
    awsPublishedAt: z.string().nullable(),
    /** 'bundled' = まだ取得できていない (同梱の値で計算している)。
     *  費用 0 が「無料」なのか「単価を引けていない」のかを区別するために要る。 */
    source: z.enum(['bundled', 'fetched']),
    /** 単価を取得した日時 (ISO)。同梱を使っているときは null。 */
    fetchedAt: z.string().nullable(),
    /** 取得から時間が経ちすぎている。更新を促すために出す。 */
    stale: z.boolean(),
    /** 料金 API から取れず手で持っている値。**更新しても変わらない部分**。 */
    manualFacts: z.object({
      verifiedOn: z.string(),
      notes: z.array(z.string()),
      sources: z.array(z.string()),
    }),
  }),
  candidates: z.array(TransferCandidate),
})
export type TransferEstimate = z.infer<typeof TransferEstimate>

// ── Dataset lineage (spec: 2026-08-26-auth-lineage-platform-design.md) ──
// API は React Flow に依存しない domain DTO を返す。キャンバス用の座標や
// node type への変換は front/lib/lineage だけで行う。
export const LineageProjection = z.enum(['logical', 'versions'])
export type LineageProjection = z.infer<typeof LineageProjection>

export const DatasetCatalogItem = z.object({
  kind: z.enum(['dataset', 'source']),
  datasetId: z.string().nullable(),
  datasetKey: z.string().nullable(),
  namespace: z.string(),
  name: z.string(),
  displayName: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([]),
  description: z.string().nullable(),
  mediaType: z.string().nullable(),
  owner: z.string().nullable(),
  currentVersionId: z.string().nullable(),
  versionCount: z.number().int().nonnegative(),
})
export type DatasetCatalogItem = z.infer<typeof DatasetCatalogItem>

export const DatasetCatalogResponse = z.object({
  results: z.array(DatasetCatalogItem),
  totalCount: z.number().int().nonnegative(),
})

export const StorageLineageMatch = DatasetCatalogItem.extend({
  versionId: z.string(),
  version: z.string(),
  versionCreatedAt: z.string(),
  locationId: z.string(),
  locationUri: z.string(),
  status: z.enum(['available', 'archived', 'missing', 'deleted', 'unknown']),
  isPrimary: z.boolean(),
  observedAt: z.string(),
  matchType: z.enum(['exact', 'prefix']),
})

export const StorageLineageResolution = z.object({
  storageSystemKey: z.string().nullable(),
  uri: z.string(),
  matches: z.array(StorageLineageMatch),
})
export type StorageLineageResolution = z.infer<typeof StorageLineageResolution>

export const ManualLineageMutationResult = z.record(z.string(), z.unknown())

export interface ManualStorageLocationInput {
  connectionId: string
  bucket: string
  key: string
  status: 'available' | 'archived' | 'missing' | 'deleted' | 'unknown'
  isPrimary: boolean
}

export interface ManualDatasetRegistrationInput {
  datasetId?: string
  dataset?: {
    datasetKey: string
    namespace: string
    name: string
    displayName?: string
    aliases: string[]
    description?: string
    mediaType?: string
    owner?: string
  }
  version: {
    version: string
    contentHash?: string
    manifestUri?: string
    manifestHash?: string
    schemaUri?: string
  }
  location?: ManualStorageLocationInput
  source?: {
    sourceKey: string
    kind: 'purchased' | 'crawled' | 'provided' | 'generated' | 'database' | 'other'
    name: string
    uri?: string
    vendor?: string
    product?: string
    licenseRef?: string
    contractRef?: string
  }
  processing?: {
    transformation: ManualTransformationInput
    inputVersionIds: string[]
    jobNamespace: string
    jobName: string
    gitSha?: string
    containerDigest?: string
    configUri?: string
    configHash?: string
    executionTimeStatus: 'known' | 'unknown'
    occurredAt?: string
  }
  evidenceRefs: string[]
}

export interface LineageDatasetUpdateInput {
  displayName?: string | null
  aliases?: string[]
  description?: string | null
  mediaType?: string | null
  owner?: string | null
}

export interface ManualTransformationInput {
  transformationKey: string
  name: string
  description?: string
  codeRepository?: string
  defaultCodeRef?: string
}

export interface ManualLineageRegistrationInput {
  transformation: ManualTransformationInput
  inputVersionIds: string[]
  outputVersionIds: string[]
  jobNamespace: string
  jobName: string
  gitSha?: string
  containerDigest?: string
  configUri?: string
  configHash?: string
  executionTimeStatus: 'known' | 'unknown'
  occurredAt?: string
  evidenceRefs: string[]
}

export const LineageNodeKind = z.enum(['source', 'dataset', 'job', 'version', 'run', 'location'])
export type LineageNodeKind = z.infer<typeof LineageNodeKind>

export const LineageNodeSummary = z.object({
  id: z.string(),
  kind: LineageNodeKind,
  label: z.string(),
  namespace: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  summary: z.record(z.string(), z.unknown()).optional().default({}),
  data: z.record(z.string(), z.unknown()).optional().default({}),
  updatedAt: z.string().nullable().optional(),
  completeness: z.enum(['complete', 'partial', 'unregistered']).optional(),
  registry: z.object({
    kind: z.enum(['dataset', 'source']),
    datasetId: z.string().nullable(),
    datasetKey: z.string().nullable(),
    namespace: z.string(),
    name: z.string(),
    displayName: z.string().nullable().default(null),
    aliases: z.array(z.string()).default([]),
    description: z.string().nullable(),
    mediaType: z.string().nullable(),
    owner: z.string().nullable(),
    currentVersionId: z.string().nullable(),
    versionCount: z.number().int().nonnegative(),
  }).nullable().optional(),
  latestRun: z.object({
    id: z.string().nullable(),
    state: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  }).nullable().optional(),
})
export type LineageNodeSummary = z.infer<typeof LineageNodeSummary>

export const LineageEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.string(),
})
export type LineageEdge = z.infer<typeof LineageEdge>

export const LineageProjectionStatus = z.object({
  state: z.string(),
  pendingEvents: z.number().int().nonnegative().nullable().optional().default(0),
  oldestPendingAt: z.string().nullable().optional(),
  message: z.string().optional(),
})
export type LineageProjectionStatus = z.infer<typeof LineageProjectionStatus>

export const LineageGraph = z.object({
  root: z.object({
    kind: z.enum(['dataset', 'job']),
    namespace: z.string(),
    name: z.string(),
    nodeId: z.string(),
  }).optional(),
  rootVersionId: z.string().optional(),
  nodes: z.array(LineageNodeSummary),
  edges: z.array(LineageEdge),
  projection: LineageProjectionStatus.optional(),
  generatedAt: z.string().optional(),
  truncated: z.boolean().optional().default(false),
  warnings: z.array(z.string()).optional().default([]),
})
export type LineageGraph = z.infer<typeof LineageGraph>

export const LineageStorageLocationDetail = z.object({
  id: z.string(),
  uri: z.string(),
  storageKind: z.string(),
  storageSystemKey: z.string().nullable(),
  region: z.string().nullable(),
  bucket: z.string().nullable(),
  status: z.enum(['available', 'archived', 'missing', 'deleted', 'unknown']),
  isPrimary: z.boolean(),
  observedAt: z.string(),
  madoConnectionId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
})
export type LineageStorageLocationDetail = z.infer<typeof LineageStorageLocationDetail>

export const DatasetVersionDetail = z.object({
  id: z.string(),
  datasetId: z.string(),
  version: z.string(),
  contentHash: z.string().nullable(),
  manifestUri: z.string().nullable(),
  manifestHash: z.string().nullable(),
  schemaUri: z.string().nullable(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  locations: z.array(LineageStorageLocationDetail),
})
export type DatasetVersionDetail = z.infer<typeof DatasetVersionDetail>

export const DatasetDetail = z.object({
  kind: z.enum(['dataset', 'source']),
  datasetId: z.string().nullable(),
  datasetKey: z.string().nullable(),
  namespace: z.string(),
  name: z.string(),
  displayName: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([]),
  description: z.string().nullable(),
  mediaType: z.string().nullable(),
  owner: z.string().nullable(),
  currentVersionId: z.string().nullable(),
  versionCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  versions: z.array(DatasetVersionDetail),
})
export type DatasetDetail = z.infer<typeof DatasetDetail>

export const LineageRunDatasetRef = z.object({
  versionId: z.string(),
  version: z.string(),
  namespace: z.string(),
  name: z.string(),
  primaryUri: z.string().nullable(),
  storageKind: z.string().nullable(),
})

export const LineageRunDetail = z.object({
  id: z.string(),
  runKey: z.string(),
  jobNamespace: z.string(),
  jobName: z.string(),
  status: z.enum(['RUNNING', 'COMPLETE', 'FAIL', 'ABORT']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  gitSha: z.string().nullable(),
  containerDigest: z.string().nullable(),
  configUri: z.string().nullable(),
  configHash: z.string().nullable(),
  modelRefs: z.array(z.record(z.string(), z.unknown())),
  runtime: z.record(z.string(), z.unknown()),
  metrics: z.record(z.string(), z.unknown()),
  errorMessage: z.string().nullable(),
  inputs: z.array(LineageRunDatasetRef),
  outputs: z.array(LineageRunDatasetRef),
  sources: z.array(z.record(z.string(), z.unknown())),
})
export type LineageRunDetail = z.infer<typeof LineageRunDetail>
