import { S3Client } from '@aws-sdk/client-s3'
import type { Pools } from './db.js'
import type { CryptoModule } from './crypto.js'

export interface StorageFactory {
  /** 指定した connectionId のキャッシュ済み S3Client を返す。
   *  接続が存在しない場合は { code: 'NOT_FOUND' } (Error に .code あり) を投げる。 */
  getStorage(connId: string): Promise<S3Client>
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

export function createStorageFactory(deps: StorageFactoryDeps): StorageFactory {
  const cache = new Map<string, S3Client>()

  async function getStorage(connId: string): Promise<S3Client> {
    const cached = cache.get(connId)
    if (cached) return cached

    const r = await deps.pools.ro.query(
      `SELECT endpoint, region, access_key_id_enc, secret_access_key_enc, force_path_style
         FROM storage_connections WHERE id = $1`,
      [connId],
    )
    const row = r.rows[0] as
      | {
          endpoint: string
          region: string
          access_key_id_enc: string
          secret_access_key_enc: string
          force_path_style: boolean
        }
      | undefined
    if (!row) throw new ConnectionNotFoundError(connId)

    const client = new S3Client({
      endpoint: row.endpoint,
      region: row.region,
      credentials: {
        accessKeyId: deps.crypto.decrypt(row.access_key_id_enc),
        secretAccessKey: deps.crypto.decrypt(row.secret_access_key_enc),
      },
      forcePathStyle: row.force_path_style,
    })
    cache.set(connId, client)
    return client
  }

  function invalidate(connId: string): void {
    const c = cache.get(connId)
    if (c) {
      c.destroy()
      cache.delete(connId)
    }
  }

  async function close(): Promise<void> {
    for (const c of cache.values()) c.destroy()
    cache.clear()
  }

  return { getStorage, invalidate, close }
}
