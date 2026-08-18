import { createHash } from 'node:crypto'

// /list と /buckets の応答キャッシュ。
//
// 目的は「誰か一人が開けば全員速い」状態を作ること。mdx の dataset バケットは
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
