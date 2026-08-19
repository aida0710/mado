import { createHash } from 'node:crypto'

// /list と /buckets の応答キャッシュ。
//
// 目的は「誰か一人が開けば全員速い」状態を作ること。ある巨大なバケットは
// Delimiter 付き ListObjects に 35 秒かかり (547,259 キーの線形走査。s3cmd でも
// 同じなのでアプリ側に改善余地はない)、クライアント側の localStorage キャッシュ
// はブラウザごとにしか効かないため、人数分・端末分だけ 35 秒が発生していた。
//
// 書き込み先は storage_response_cache の 1 テーブルのみ。GET 経路が rw プールを
// 触ることになるが、影響範囲をこの 1 テーブルに閉じることで許容している
// (専用ロールを切る案は、稼働中 DB への手動 CREATE ROLE が必要なため見送り)。

export type CacheKind = 'list' | 'buckets'

export interface CacheScope {
  kind: CacheKind
  connId: string
  bucket?: string
  prefix?: string
  recursive?: boolean
  continuation?: string
  startAfter?: string
}

/** サーバー側 TTL。クライアント側の 6 時間とは役割が違う —
 *  クライアントは「即座に描画する」ため、こちらは「35 秒を全体で 1 回に減らす」ため。 */
export const LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** sha256(JSON([...])) の hex。media_cache と同じ方式。
 *  省略可能な項目は空文字に正規化するので、未指定と '' は同じキーになる。 */
export function cacheKey(s: CacheScope): string {
  return createHash('sha256')
    .update(JSON.stringify([
      s.kind,
      s.connId,
      s.bucket ?? '',
      s.prefix ?? '',
      s.recursive ? 'r' : '',
      s.continuation ?? '',
      s.startAfter ?? '',
    ]))
    .digest('hex')
}

/** node-postgres の Pool が構造的に満たす最小の形。
 *  これだけを要求することで、ユニットテストが実 DB 無しで書ける。 */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: any[]): Promise<{ rows: any[] }>
}

export interface ResponseCache {
  get(scope: CacheScope): Promise<unknown | null>
  /** ttlMs を渡すと既定を上書きする (バケットごとの list_cache_ttl_sec 用)。 */
  set(scope: CacheScope, payload: unknown, ttlMs?: number): Promise<void>
  invalidateScope(connId: string, bucket: string, prefix: string): Promise<void>
  invalidateConnection(connId: string): Promise<void>
}

// キャッシュ層で例外を握りつぶす理由: 呼び出し側 (ルート) に try/catch を
// 散らすより 1 箇所に閉じ込めた方が「キャッシュは壊さない」が守りやすい。
// get が null を返せば呼び出し側は miss として S3 へ行くだけで済む。
function swallow(op: string, e: unknown): void {
  console.error(JSON.stringify({ ev: 'storage.cache.error', op, error: String(e) }))
}

export function createResponseCache(db: Queryable, ttlMs: number = LIST_CACHE_TTL_MS): ResponseCache {
  return {
    async get(scope) {
      try {
        const r = await db.query(
          `SELECT payload FROM storage_response_cache
            WHERE cache_key = $1 AND expires_at > now()`,
          [cacheKey(scope)],
        )
        const row = r.rows[0] as { payload: unknown } | undefined
        return row ? row.payload : null
      } catch (e) {
        swallow('get', e)
        return null
      }
    },

    async set(scope, payload, overrideTtlMs) {
      try {
        // 期限切れ行は次回の取得時にこの UPSERT で上書きされるので、
        // 読み出し時の掃除も定期ジョブも要らない。
        await db.query(
          `INSERT INTO storage_response_cache
             (cache_key, conn_id, bucket, prefix, payload, expires_at)
           VALUES ($1, $2, $3, $4, $5, now() + ($6::bigint || ' milliseconds')::interval)
           ON CONFLICT (cache_key) DO UPDATE SET
             payload    = EXCLUDED.payload,
             fetched_at = now(),
             expires_at = EXCLUDED.expires_at`,
          [
            cacheKey(scope),
            scope.connId,
            scope.bucket ?? '',
            scope.prefix ?? '',
            JSON.stringify(payload),
            overrideTtlMs ?? ttlMs,
          ],
        )
      } catch (e) {
        swallow('set', e)
      }
    },

    async invalidateScope(connId, bucket, prefix) {
      try {
        await db.query(
          `DELETE FROM storage_response_cache
            WHERE conn_id = $1 AND bucket = $2 AND prefix = $3`,
          [connId, bucket, prefix],
        )
      } catch (e) {
        swallow('invalidateScope', e)
      }
    },

    async invalidateConnection(connId) {
      try {
        await db.query('DELETE FROM storage_response_cache WHERE conn_id = $1', [connId])
      } catch (e) {
        swallow('invalidateConnection', e)
      }
    },
  }
}
