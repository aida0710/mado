// 一覧の「いま見ているデータがいつのものか」をテーブルヘッダの直上に出す帯。
//
// ページャの隅に "取得 22:13" と添えていた頃は視線が届かず、古いキャッシュを
// 最新だと思って見てしまう事故があった。Name / Size / Modified の真上に置き、
// 目に入る位置へ移したのがこれ。
//
// 2 状態:
//   更新中 (revalidating) — 地色を敷き、取得時刻と「更新しています」を左右に
//                           振り分け、下端で不定長 progress を走らせる。
//   最新                   — 地色を落として 1 行に退く。消してしまうと
//                           「いつのデータか」が分からなくなるので残す。
//
// progress は S3 の list では残り時間が出せないので不定長。0.1 秒で終わる
// バケットではバーが一瞬光るだけでちらつくため、200ms 遅れて現れるように
// CSS の animation-delay で伏せている (JS タイマーを持たない = 後始末も不要)。

import { fmtCacheTime } from '../../lib/format'

interface Props {
  /** このページのデータを S3 から取得した時刻。null = まだ無い / invalidate 直後。 */
  fetchedAt: Date | null
  /** 期限切れキャッシュを表示したまま裏で再取得中か。 */
  revalidating: boolean
}

export function CacheBanner({ fetchedAt, revalidating }: Props) {
  if (!fetchedAt) return null
  const iso = fetchedAt.toISOString()
  const at = (
    <time dateTime={iso} title={iso} className="cache-banner__at">
      {fmtCacheTime(fetchedAt)}
    </time>
  )

  if (!revalidating) {
    return (
      <div className="cache-banner">
        <p className="cache-banner__body">
          <span className="cache-banner__dot cache-banner__dot--live" aria-hidden />
          {at} に取得した最新の情報です
        </p>
      </div>
    )
  }

  return (
    <div className="cache-banner cache-banner--stale">
      <p className="cache-banner__body">
        <span>現在表示中の情報は {at} に取得されたものです</span>
        <span className="cache-banner__status" aria-live="polite">
          <span className="cache-banner__dot" aria-hidden />
          最新の情報に更新しています
        </span>
      </p>
      <div className="cache-banner__track">
        <div role="progressbar" aria-label="最新の情報を取得中" className="cache-banner__bar" />
      </div>
    </div>
  )
}
