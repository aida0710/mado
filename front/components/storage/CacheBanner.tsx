// 一覧の「いま見ているデータがいつのものか」と、その場で取り直す ↻ を
// テーブルヘッダの直上に並べた帯。
//
// ページャの隅に "取得 22:13" と添えていた頃は視線が届かず、古いキャッシュを
// 最新だと思って見てしまう事故があった。Name / Size / Modified の真上に置き、
// 更新操作も同じ場所に集めた (以前はページャの ↻ と離れていた)。
//
// 2 状態:
//   更新中 (revalidating) — 地色を敷き、下端で不定長 progress を走らせる。
//   最新                   — 地色を落として 1 行に退く。消してしまうと
//                            「いつのデータか」が分からなくなるので残す。
//
// progress は S3 の list では残り時間が出せないので不定長。0.1 秒で終わる
// バケットではバーが一瞬光るだけでちらつくため、200ms 遅れて現れるように
// CSS の animation-delay で伏せている (JS タイマーを持たない = 後始末も不要)。

import { useEffect, useState } from 'react'
import { fmtCacheAge } from '../../lib/format'

interface Props {
  /** このページのデータを S3 から取得した時刻。null = まだ無い / invalidate 直後。 */
  fetchedAt: Date | null
  /** 期限切れキャッシュを表示したまま裏で再取得中か。 */
  revalidating: boolean
  /** ↻ を押したとき。キャッシュを破棄してサーバーごと取り直す。 */
  onRefresh: () => void
  /** Σ を押したとき。配下のオブジェクト数・サイズを集計するモーダルを開く。 */
  onScan?: () => void
}

// 相対時刻 ("2時間前") は時間が経つと嘘になる。タブを開きっぱなしにしても
// 表示が追従するよう 1 分ごとに再描画する。絶対時刻も併記しているので
// 実害は小さいが、見出しの情報が古いままなのは避ける。
function useMinuteTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])
}

export function CacheBanner({ fetchedAt, revalidating, onRefresh, onScan }: Props) {
  useMinuteTick()

  return (
    <div className={`cache-banner${revalidating ? ' cache-banner--stale' : ''}`}>
      <p className="cache-banner__body">
        <button
          type="button"
          className="cache-banner__refresh"
          onClick={onRefresh}
          disabled={revalidating}
          title="キャッシュを破棄して再読み込み"
          aria-label="再読み込み"
        >
          <span aria-hidden>↻</span>
        </button>
        {/* fetchedAt が無いのは初回ロード中や invalidate 直後。日時は出せないが
            ボタンは残す — ここで更新手段が消えると詰まったときに何もできない。 */}
        {fetchedAt && (
          <span>
            <time dateTime={fetchedAt.toISOString()} className="cache-banner__at">
              {fmtCacheAge(fetchedAt)}
            </time>
            に取得した情報です
          </span>
        )}
        {onScan && (
          <button
            type="button"
            className="cache-banner__refresh"
            onClick={onScan}
            title="配下のオブジェクト数とサイズを集計する"
            aria-label="配下を集計"
          >
            <span aria-hidden>Σ</span>
          </button>
        )}
        {revalidating && (
          <span className="cache-banner__status" aria-live="polite">
            <span className="cache-banner__dot" aria-hidden />
            最新の情報に更新しています
          </span>
        )}
      </p>
      {revalidating && (
        <div className="cache-banner__track">
          <div role="progressbar" aria-label="最新の情報を取得中" className="cache-banner__bar" />
        </div>
      )}
    </div>
  )
}
