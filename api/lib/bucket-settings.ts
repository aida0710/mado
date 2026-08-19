import type { Pools } from '../db.js'

// バケット単位の設定 (spec: 2026-08-18-directory-scan-design.md)。
// connection_settings と同じ key/value 形式。未設定なら既定値に倒す。

export interface BucketSettings {
  /** false なら走査を投入できない (API も 403)。巨大バケットのガード。 */
  scanEnabled: boolean
  /** 一覧キャッシュの TTL。更新の激しいバケットは短く。 */
  listCacheTtlSec: number
}

export const DEFAULT_BUCKET_SETTINGS: BucketSettings = {
  scanEnabled: true,
  listCacheTtlSec: 86400,
}

export function createBucketSettings(pools: Pools) {
  return {
    async get(connId: string, bucket: string): Promise<BucketSettings> {
      const r = await pools.ro.query<{ key: string; value: string }>(
        'SELECT key, value FROM bucket_settings WHERE connection_id = $1 AND bucket = $2',
        [connId, bucket],
      )
      const m = new Map(r.rows.map(x => [x.key, x.value]))

      const ttlRaw = Number(m.get('list_cache_ttl_sec'))
      return {
        // 'false' だけを無効とみなす (connection_settings と同じ約束)。
        scanEnabled: m.get('scan_enabled') !== 'false',
        listCacheTtlSec: Number.isFinite(ttlRaw) && ttlRaw > 0
          ? ttlRaw
          : DEFAULT_BUCKET_SETTINGS.listCacheTtlSec,
      }
    },

    async set(connId: string, bucket: string, key: string, value: string): Promise<void> {
      await pools.rw.query(
        `INSERT INTO bucket_settings (connection_id, bucket, key, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (connection_id, bucket, key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [connId, bucket, key, value],
      )
    },
  }
}
