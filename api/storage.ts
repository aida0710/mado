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

/** 接続行から読み出した API 設定。S3Client では表現できない (= 呼ぶコマンドが
 *  違う等) サーバ依存のパラメータをここに集約する。 */
export interface ConnectionConfig {
  /** ListObjects に v1 (Marker/NextMarker) と v2 (ContinuationToken/StartAfter) の
   *  どちらを使うか。DDN 製や古い NetApp 等は v1 only、AWS/R2/MinIO は v2 推奨。 */
  listObjectsVersion: ListObjectsVersion
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
}

export function createStorageFactory(deps: StorageFactoryDeps): StorageFactory {
  // client と connection 設定 (list_objects_version 等) を 1 entry にまとめて
  // キャッシュする。getStorage と getConnectionConfig は同じ DB row から派生
  // する値を共有するので、別々にキャッシュすると 2 度引きや invalidate ズレが起きる。
  const cache = new Map<string, CachedEntry>()

  async function load(connId: string): Promise<CachedEntry> {
    const cached = cache.get(connId)
    if (cached) return cached

    const r = await deps.pools.ro.query<DbRow>(
      `SELECT endpoint, region, access_key_id_enc, secret_access_key_enc,
              force_path_style, list_objects_version
         FROM storage_connections WHERE id = $1`,
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
      // 明示的に keep-alive を効かせる。さらに maxAttempts=2 にして「成功するまでの
      // 隠れたリトライ」を短く切る (DDN 製ストレージ等で初回 200 が遅延する時に
      // SDK 内で数秒の指数バックオフ + 再試行を踏むケースを回避)。
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({
        httpAgent,
        httpsAgent,
        connectionTimeout: 5_000,
        socketTimeout:    30_000,
      }),
    })
    const entry: CachedEntry = {
      client,
      config: { listObjectsVersion: row.list_objects_version },
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
