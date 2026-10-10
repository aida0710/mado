// 一覧の「いま見ているデータがいつのものか」と、その場で取り直す再読み込みを
// 表の見出しの直上に並べた帯。
//
// ページャの隅に "取得 22:13" と添えていた頃は視線が届かず、古いキャッシュを
// 最新だと思って見てしまう事故があった。Name / Size / Modified の真上に置き、
// 再読み込みも同じ場所に集める。
//
// 取得からの経過時間の段階 (lib/cacheAgeLevel.ts) を data-age に持たせ、帯の左の線・
// 淡い地・文字の色を段階ごとに変える (色は styles/storage.css の --cache-age-*)。
// 一覧では同じ線を表の左端にも引くので、下へスクロールしても古さが目に入る。
//
// 更新中 (revalidating) は「更新しています」と不定長の進捗を出す。S3 の list では
// 残り時間が出せないので割合は出さない。0.1 秒で終わるバケットでは一瞬光るだけで
// ちらつくため、CSS の animation-delay で 200ms 伏せている (JS タイマーを持たない)。

import { useEffect, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { cacheAgeLevel } from '../../lib/cacheAgeLevel'
import { fmtCacheAge } from '../../lib/format'

interface Props {
  /** このページのデータを S3 から取得した時刻。null = まだ無い / invalidate 直後。 */
  fetchedAt: Date | null
  /** 期限切れキャッシュを表示したまま裏で再取得中か。 */
  revalidating: boolean
  /** 再読み込みを押したとき。キャッシュを破棄してサーバーごと取り直す。 */
  onRefresh: () => void
  /** 狭い見出しの中に収める形。帯を敷かず、文言を落として時刻だけにする。
   *  README / バケット一覧 / tar プレビューで使う。 */
  compact?: boolean
  /** 右端に差し込む内容。一覧では配下の集計の要約が入る。
   *  CacheBanner 自体は走査を知らない (差し込む側の責務)。 */
  trailing?: ReactNode
}

// 相対時刻 ("2時間前") と経過時間の色は時間が経つと嘘になる。タブを開きっぱなしに
// しても表示が追従するよう 1 分ごとに再描画する。絶対時刻も併記しているので
// 実害は小さいが、見出しの情報が古いままなのは避ける。
function useMinuteTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])
}

export function CacheBanner({ fetchedAt, revalidating, onRefresh, compact, trailing }: Props) {
  useMinuteTick()
  const now = new Date()
  const age = fetchedAt ? cacheAgeLevel(fetchedAt, now) : null

  return (
    <div className={compact ? 'cache-banner cache-banner-compact' : 'cache-banner'} data-age={age?.level}>
      <p className="cache-banner-body">
        <button
          type="button"
          className="icon-button cache-banner-refresh"
          onClick={onRefresh}
          disabled={revalidating}
          title="キャッシュを破棄して再読み込み"
          aria-label="再読み込み"
        >
          <RefreshCw size={14} aria-hidden="true" className={revalidating ? 'spin' : undefined} />
        </button>
        {/* fetchedAt が無いのは初回ロード中や invalidate 直後。日時は出せないが
            ボタンは残す — ここで更新手段が消えると詰まったときに何もできない。 */}
        {fetchedAt && age && (
          <span>
            <time
              dateTime={fetchedAt.toISOString()}
              className="cache-banner-at"
              data-age={age.level}
              title={age.label}
            >
              {fmtCacheAge(fetchedAt, now, { compact })}
            </time>
            {!compact && 'に取得した情報です'}
          </span>
        )}
        {revalidating && (
          <span className="cache-banner-status" aria-live="polite">
            <span className="storage-pulse-dot" aria-hidden="true" />
            {compact ? '更新中' : '最新の情報に更新しています'}
          </span>
        )}
        {trailing && <span className="cache-banner-trailing">{trailing}</span>}
      </p>
      {revalidating && (
        <div className="storage-busy-track cache-banner-track">
          <div role="progressbar" aria-label="最新の情報を取得中" className="storage-busy-bar" />
        </div>
      )}
    </div>
  )
}
