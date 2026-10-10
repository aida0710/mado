// 容量メトリクス画面のバケットに付く、バケット直下のディレクトリ別の内訳。
//
// 値はバケット全体と同じ完全走査で数えたもの (サイズ上位の直下ディレクトリだけ)。
// 推移グラフは行を開いたときだけ取得する。1 バケットに数十行あり、全部の履歴を
// 一覧と一緒に返すと応答が大きくなりすぎるため。

import { lazy, Suspense, useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api/client'
import type { CapacityPoint, CapacityPrefixSummary } from '../../lib/api/types'
import { fmtCapacityBytes, fmtCapacityDelta } from '../../lib/format'
import { storageDirectoryHref } from '../../lib/route'

const CapacityHistoryChart = lazy(() => import('./CapacityHistoryChart'))

/** 最初に見せる行数。容量の大きい順なので、上位だけで大半の容量を占めることが多い。 */
const INITIAL_VISIBLE_PREFIXES = 5
/** 表の列の数。開いた行の推移はこの幅いっぱいに出す。 */
const COLUMN_COUNT = 5

// 共通の表。自動の列幅 (table-layout: auto) なので、狭い画面で列を隠しても
// 隠した列の幅は残らない。640px 未満は割合とオブジェクト数、900px 未満は前回からを
// 隠し、名前と容量を残す (storage.css の .capacity-col-*)。

interface Props {
  connectionId: string
  bucket: string
  /** 内訳と同じ計測でのバケット全体の値。内訳に入らなかった残りを出すのに使う。 */
  bucketTotalBytes: number
  bucketObjectCount: number
  prefixes: CapacityPrefixSummary[]
  days: number
  intervalSeconds: number
}

export function BucketPrefixCapacity({
  connectionId, bucket, bucketTotalBytes, bucketObjectCount, prefixes, days, intervalSeconds,
}: Props) {
  const [showAll, setShowAll] = useState(false)
  const [openPrefix, setOpenPrefix] = useState<string | null>(null)

  if (prefixes.length === 0) {
    return (
      <p className="muted capacity-prefixes-empty">
        直下のディレクトリ別の内訳はありません（直下にディレクトリが無いか、内訳を保存する前の計測です）。
      </p>
    )
  }

  const visible = showAll ? prefixes : prefixes.slice(0, INITIAL_VISIBLE_PREFIXES)
  const hiddenCount = prefixes.length - visible.length
  const restBytes = bucketTotalBytes - prefixes.reduce((sum, prefix) => sum + prefix.totalBytes, 0)
  const restObjects = bucketObjectCount - prefixes.reduce((sum, prefix) => sum + prefix.objectCount, 0)

  return (
    <section className="capacity-prefixes" aria-label={`${bucket}の直下のディレクトリ別の容量`}>
      <div className="capacity-prefixes-heading">
        <h4>直下のディレクトリ別</h4>
        <p className="muted">容量の大きい{prefixes.length.toLocaleString('ja-JP')}件</p>
      </div>
      <div className="table-scroll">
        <table aria-label={`${bucket}の直下のディレクトリ`}>
          <thead>
            <tr>
              <th scope="col">ディレクトリ</th>
              <th scope="col" className="numeric">容量</th>
              <th scope="col" className="capacity-col-share">割合</th>
              <th scope="col" className="numeric capacity-col-delta">前回から</th>
              <th scope="col" className="numeric capacity-col-objects">オブジェクト数</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(prefix => (
              <PrefixRow
                key={prefix.prefix}
                connectionId={connectionId}
                bucket={bucket}
                prefix={prefix}
                share={bucketTotalBytes > 0 ? prefix.totalBytes / bucketTotalBytes : 0}
                open={openPrefix === prefix.prefix}
                onToggle={() => setOpenPrefix(current => current === prefix.prefix ? null : prefix.prefix)}
                days={days}
                intervalSeconds={intervalSeconds}
              />
            ))}
            {hiddenCount === 0 && restBytes > 0 && (
              <tr>
                <td className="muted capacity-rest-name">直下のファイル・上位に入らないディレクトリ</td>
                <td className="numeric mono nowrap">{fmtCapacityBytes(restBytes)}</td>
                <td className="capacity-col-share">
                  <ShareBar share={bucketTotalBytes > 0 ? restBytes / bucketTotalBytes : 0} />
                </td>
                <td className="numeric mono capacity-col-delta">—</td>
                <td className="numeric mono capacity-col-objects">{Math.max(0, restObjects).toLocaleString('ja-JP')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {prefixes.length > INITIAL_VISIBLE_PREFIXES && (
        <button type="button" className="button small capacity-prefixes-more" onClick={() => setShowAll(value => !value)}>
          {showAll ? `上位${INITIAL_VISIBLE_PREFIXES}件だけ表示` : `残り${hiddenCount.toLocaleString('ja-JP')}件も表示`}
        </button>
      )}
    </section>
  )
}

function PrefixRow({ connectionId, bucket, prefix, share, open, onToggle, days, intervalSeconds }: {
  connectionId: string
  bucket: string
  prefix: CapacityPrefixSummary
  share: number
  open: boolean
  onToggle: () => void
  days: number
  intervalSeconds: number
}) {
  const trendId = useId()
  return (
    <>
      <tr className={open ? 'selected' : undefined}>
        <td>
          <span className="capacity-prefix-name">
            <button
              type="button"
              className="capacity-prefix-toggle"
              aria-expanded={open}
              aria-controls={trendId}
              title="推移を表示"
              onClick={onToggle}
            >
              {open
                ? <ChevronDown size={14} aria-hidden="true" />
                : <ChevronRight size={14} aria-hidden="true" />}
              <span className="mono">{prefix.prefix}</span>
            </button>
            <Link
              className="capacity-open-link"
              to={storageDirectoryHref(connectionId, bucket, prefix.prefix)}
              aria-label={`${prefix.prefix}を開く`}
            >
              開く
              <ArrowRight size={12} aria-hidden="true" />
            </Link>
          </span>
        </td>
        <td className="numeric mono nowrap">{fmtCapacityBytes(prefix.totalBytes)}</td>
        <td className="capacity-col-share"><ShareBar share={share} /></td>
        <td className="numeric mono nowrap capacity-col-delta">
          {prefix.previous ? fmtCapacityDelta({ current: prefix.totalBytes, previous: prefix.previous.totalBytes }) : '—'}
        </td>
        <td className="numeric mono capacity-col-objects">{prefix.objectCount.toLocaleString('ja-JP')}</td>
      </tr>
      {open && (
        <tr id={trendId} className="capacity-trend-row">
          <td colSpan={COLUMN_COUNT}>
            <PrefixTrend
              connectionId={connectionId} bucket={bucket} prefix={prefix.prefix}
              days={days} intervalSeconds={intervalSeconds}
            />
          </td>
        </tr>
      )}
    </>
  )
}

function ShareBar({ share }: { share: number }) {
  const percent = Math.min(100, Math.max(0, share * 100))
  return (
    <span className="capacity-share">
      <span className="storage-meter" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="mono">{percent.toFixed(1)}%</span>
    </span>
  )
}

function PrefixTrend({ connectionId, bucket, prefix, days, intervalSeconds }: {
  connectionId: string
  bucket: string
  prefix: string
  days: number
  intervalSeconds: number
}) {
  const [points, setPoints] = useState<CapacityPoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api.capacityPrefixHistory({ connectionId, bucket, prefix, days })
      .then(result => { if (active) { setPoints(result.points); setError(null) } })
      .catch(cause => { if (active) setError((cause as Error).message) })
    return () => { active = false }
  }, [connectionId, bucket, prefix, days])

  if (error) return <p className="notice error">{error}</p>
  if (!points) return <p className="capacity-chart-placeholder">推移を読み込み中…</p>
  if (points.length < 2) {
    return <p className="capacity-chart-empty">2回計測するとグラフを表示します</p>
  }
  return (
    <Suspense fallback={<p className="capacity-chart-placeholder">グラフを読み込み中…</p>}>
      <CapacityHistoryChart points={points} intervalSeconds={intervalSeconds} capacityBytes={null} label={`${bucket}/${prefix}`} />
    </Suspense>
  )
}
