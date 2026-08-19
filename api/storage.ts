import { S3Client } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import type { Pools } from './db.js'
import type { CryptoModule } from './crypto.js'

// すべての S3Client で共有する keep-alive 付き agent。
// AWS SDK v3 はバージョンによってデフォルトの keep-alive 挙動が違うため、
// 明示的に設定して LAN MinIO / DDN 製ストレージ等の TLS ハンドシェイク往復を抑える。
const httpAgent  = new HttpAgent({  keepAlive: true, maxSockets: 50 })
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 50 })

export type ListObjectsVersion = 'v1' | 'v2'

/** 接続ごとに許可する操作。既定はすべて true (= マイグレーション前と同じ挙動)。
 *
 *  認証が無い前提のツールなので、これはアクセス制御ではなく **誤操作の防止**。
 *  Deep Archive のように GetObject 自体が失敗する / 課金されるバケットや、
 *  書き戻したくない本番バケットを登録した接続で、危険な導線を閉じるためにある。
 *  UI で隠すだけだと共有 Web URL を直に叩けてしまうので、API 側でも
 *  lib/capabilityGuard.ts が 403 で止める。 */
export interface Capabilities {
  /** バケット / オブジェクトの一覧 (`/buckets`, `/list`)。 */
  list: boolean
  /** テキスト / 画像 / 音声のプレビュー (`/preview/text|image|audio`)。 */
  preview: boolean
  /** 元ファイルのダウンロード (`/preview/raw`)。 */
  download: boolean
  /** tar / tar.gz / tar.xz の中身を開く (`/preview/tar`, `/preview/tar-entry`)。 */
  archive: boolean
  /** 音声情報・波形の解析 (`/media/analyze`)。ファイル全体を読むので重い。 */
  audioInfo: boolean
  /** スペクトログラムの表示 (`/media/spectrogram`)。 */
  audioSpectrogram: boolean
  /** README の読み込み (S3 の `README.md` を GetObject)。 */
  readmeRead: boolean
  /** README の編集 (S3 の `README.md` を PutObject)。readmeRead 必須。 */
  readmeWrite: boolean
}

export type Capability = keyof Capabilities

/** capability のキー一覧 (UI の並び順もこの順に揃える)。 */
export const CAPABILITY_KEYS: readonly Capability[] = [
  'list', 'preview', 'download', 'archive',
  'audioInfo', 'audioSpectrogram', 'readmeRead', 'readmeWrite',
] as const

/** connection_settings 上のキー名。権限以外の接続別設定と混ざらないよう
 *  `cap.` 名前空間に置く。 */
export function capabilitySettingKey(cap: Capability): string {
  return `cap.${cap}`
}

/** 接続行から読み出した API 設定。S3Client では表現できない (= 呼ぶコマンドが
 *  違う等) サーバ依存のパラメータをここに集約する。 */
export interface ConnectionConfig {
  /** ListObjects に v1 (Marker/NextMarker) と v2 (ContinuationToken/StartAfter) の
   *  どちらを使うか。DDN 製や古い NetApp 等は v1 only、AWS/R2/MinIO は v2 推奨。 */
  listObjectsVersion: ListObjectsVersion
  /** この接続で許可されている操作。 */
  capabilities: Capabilities
  /** 配下の走査 (storage.scan ジョブ) を許可するか。既定 true。
   *  巨大バケットを抱える接続で、重い走査を投入させないためのガード。 */
  scanEnabled: boolean
  /** 一覧キャッシュ (storage_response_cache) の保持秒数。既定 86400 (24 時間)。
   *  更新の激しい接続は短くする。 */
  listCacheTtlSec: number
}

export interface StorageFactory {
  /** 指定した connectionId のキャッシュ済み S3Client を返す。
   *  接続が存在しない場合は { code: 'NOT_FOUND' } (Error に .code あり) を投げる。 */
  getStorage(connId: string): Promise<S3Client>
  /** 指定した connectionId の API 設定 (list_objects_version 等) を返す。 */
  getConnectionConfig(connId: string): Promise<ConnectionConfig>
  /** connectionId のキャッシュを破棄する (UPDATE/DELETE 後に呼び出す)。 */
  invalidate(connId: string): void
  /** シャットダウン時にすべてのキャッシュ済みクライアントを破棄する。 */
  close(): Promise<void>
}

export interface StorageFactoryDeps {
  pools: Pools
  crypto: CryptoModule
}

export class ConnectionNotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const
  constructor(public readonly connectionId: string) {
    super(`connection not found: ${connectionId}`)
  }
}

interface CachedEntry {
  client: S3Client
  config: ConnectionConfig
}

interface DbRow {
  endpoint: string
  region: string
  access_key_id_enc: string
  secret_access_key_enc: string
  force_path_style: boolean
  list_objects_version: ListObjectsVersion
  settings: Record<string, string>
}

/** 走査を許可するか。'false' だけを無効とみなす (capabilities と同じ約束)。 */
export function settingsToScanEnabled(settings: Record<string, string>): boolean {
  return settings['scan_enabled'] !== 'false'
}

/** 一覧キャッシュの保持秒数。壊れた値や 0 以下は既定に倒す。 */
export const DEFAULT_LIST_CACHE_TTL_SEC = 86400
export function settingsToListCacheTtlSec(settings: Record<string, string>): number {
  const n = Number(settings['list_cache_ttl_sec'])
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIST_CACHE_TTL_SEC
}

/** connection_settings の key/value → Capabilities。
 *
 *  **行が無いキーは既定 (有効)**。'false' と明示されたときだけ無効にする。
 *  これにより、マイグレーション直後 (テーブルが空) の挙動が適用前と一致し、
 *  既存接続へのバックフィルが要らない。connections.ts のレスポンス組み立てからも
 *  使うので export する。 */
export function settingsToCapabilities(settings: Record<string, string>): Capabilities {
  const out = {} as Capabilities
  for (const cap of CAPABILITY_KEYS) {
    out[cap] = settings[capabilitySettingKey(cap)] !== 'false'
  }
  return out
}

/** 接続行と connection_settings を 1 往復で読むための SQL 断片。
 *  設定が 0 件でも `{}` になるよう COALESCE する。 */
export const CONNECTION_SETTINGS_SUBQUERY = `
  COALESCE((SELECT jsonb_object_agg(s.key, s.value)
              FROM connection_settings s
             WHERE s.connection_id = c.id), '{}'::jsonb) AS settings`

export function createStorageFactory(deps: StorageFactoryDeps): StorageFactory {
  // client と connection 設定 (list_objects_version 等) を 1 entry にまとめて
  // キャッシュする。getStorage と getConnectionConfig は同じ DB row から派生
  // する値を共有するので、別々にキャッシュすると 2 度引きや invalidate ズレが起きる。
  const cache = new Map<string, CachedEntry>()

  async function load(connId: string): Promise<CachedEntry> {
    const cached = cache.get(connId)
    if (cached) return cached

    const r = await deps.pools.ro.query<DbRow>(
      `SELECT c.endpoint, c.region, c.access_key_id_enc, c.secret_access_key_enc,
              c.force_path_style, c.list_objects_version,
              ${CONNECTION_SETTINGS_SUBQUERY}
         FROM storage_connections c WHERE c.id = $1`,
      [connId],
    )
    const row = r.rows[0]
    if (!row) throw new ConnectionNotFoundError(connId)

    const client = new S3Client({
      endpoint: row.endpoint,
      region: row.region,
      credentials: {
        accessKeyId: deps.crypto.decrypt(row.access_key_id_enc),
        secretAccessKey: deps.crypto.decrypt(row.secret_access_key_enc),
      },
      forcePathStyle: row.force_path_style,
      // 明示的に keep-alive を効かせる。リトライは 1 回だけ (= 再試行なし)。
      // ここで遅いのは「サーバが応答を作るのに時間がかかる」ケースであって、
      // 投げ直せば速くなる類の失敗ではない。maxAttempts=2 だと socketTimeout を
      // 2 回踏んで失敗までの時間がちょうど倍になるだけなので 1 に落とす。
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        httpAgent,
        httpsAgent,
        connectionTimeout: 5_000,
        // Delimiter 付き ListObjects は、実装によってはバケット全体を走査して
        // CommonPrefixes を組み立てる。mdx のオブジェクトストレージ上の巨大な
        // バケットでは prefix の絞り込みに関係なく毎回 28〜35 秒かかり、
        // 30 秒では成否が運任せになっていた (28 秒なら成功、31 秒なら 500)。
        // 実測に対して余裕を持たせる。nginx 側は proxy_read_timeout 300s なので
        // ここが律速。待たされること自体はフロントの stale-while-revalidate が
        // 隠すので、まず「成功させる」ことを優先する。
        socketTimeout:    90_000,
      }),
    })
    const entry: CachedEntry = {
      client,
      config: {
        listObjectsVersion: row.list_objects_version,
        capabilities: settingsToCapabilities(row.settings),
        scanEnabled: settingsToScanEnabled(row.settings),
        listCacheTtlSec: settingsToListCacheTtlSec(row.settings),
      },
    }
    cache.set(connId, entry)
    return entry
  }

  async function getStorage(connId: string): Promise<S3Client> {
    return (await load(connId)).client
  }

  async function getConnectionConfig(connId: string): Promise<ConnectionConfig> {
    return (await load(connId)).config
  }

  function invalidate(connId: string): void {
    const entry = cache.get(connId)
    if (entry) {
      entry.client.destroy()
      cache.delete(connId)
    }
  }

  async function close(): Promise<void> {
    for (const entry of cache.values()) entry.client.destroy()
    cache.clear()
  }

  return { getStorage, getConnectionConfig, invalidate, close }
}
