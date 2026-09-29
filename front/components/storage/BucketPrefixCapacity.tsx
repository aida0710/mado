// 容量メトリクス画面のバケットカードに付く、バケット直下のディレクトリ別の内訳。
//
// 値はバケット全体と同じ完全走査で数えたもの (サイズ上位の直下ディレクトリだけ)。
// 推移グラフは行を開いたときだけ取得する。1 バケットに数十行あり、全部の履歴を
// 一覧と一緒に返すと応答が大きくなりすぎるため。

import { lazy, Suspense, useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api/client'
import type { CapacityPoint, CapacityPrefixSummary } from '../../lib/api/types'
import { fmtCapacityBytes, fmtCapacityDelta } from '../../lib/format'
import { storageDirectoryHref } from '../../lib/route'

const CapacityHistoryChart = lazy(() => import('./CapacityHistoryChart'))

/** 最初に見せる行数。容量の大きい順なので、上位だけで大半の容量を占めることが多い。 */
const INITIAL_VISIBLE_PREFIXES = 5

// <table> の table-fixed では、狭い画面で隠した列の幅が残ってディレクトリ名が潰れたので、
// 行ごとの grid にして ARIA の role で表として読ませる。
// 狭い画面では割合・前回から・オブジェクト数を落とし、名前と容量だけにする。
const rowGridClass =
  'grid grid-cols-[minmax(0,1fr)_6.5rem] items-center border-b border-rule ' +
  'sm:grid-cols-[minmax(0,1fr)_7rem_9rem_7rem] md:grid-cols-[minmax(0,1fr)_7rem_9rem_11rem_7rem]'
const headerCellClass = 'px-2 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-7'
const numClass = 'whitespace-nowrap px-2 py-1.5 text-right font-mono text-[12px] tabular-nums'
const shareCellClass = 'hidden px-2 py-1.5 sm:block'
const deltaCellClass = `${numClass} hidden text-ink-7 md:block`
const objectCountCellClass = `${numClass} hidden text-ink-7 sm:block`

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
      <p className="mt-2 border-t border-rule pt-2 text-[11px] text-ink-7">
        直下のディレクトリ別の内訳はありません（直下にディレクトリが無いか、内訳を保存する前の計測です）。
      </p>
    )
  }

  const visible = showAll ? prefixes : prefixes.slice(0, INITIAL_VISIBLE_PREFIXES)
  const hiddenCount = prefixes.length - visible.length
  const restBytes = bucketTotalBytes - prefixes.reduce((sum, prefix) => sum + prefix.totalBytes, 0)
  const restObjects = bucketObjectCount - prefixes.reduce((sum, prefix) => sum + prefix.objectCount, 0)

  return (
    <section className="mt-2 border-t border-rule pt-2" aria-label={`${bucket}の直下のディレクトリ別の容量`}>
      <div className="flex items-baseline justify-between gap-3 px-2">
        <h4 className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-ink-7">直下のディレクトリ別</h4>
        <p className="text-[11px] text-ink-7">容量の大きい{prefixes.length.toLocaleString('ja-JP')}件</p>
      </div>
      <div role="table" className="mt-1" aria-label={`${bucket}の直下のディレクトリ`}>
        <div role="row" className={rowGridClass}>
          <span role="columnheader" className={headerCellClass}>ディレクトリ</span>
          <span role="columnheader" className={`${headerCellClass} text-right`}>容量</span>
          <span role="columnheader" className={`${headerCellClass} hidden sm:block`}>割合</span>
          <span role="columnheader" className={`${headerCellClass} hidden text-right md:block`}>前回から</span>
          <span role="columnheader" className={`${headerCellClass} hidden text-right sm:block`}>オブジェクト数</span>
        </div>
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
          <div role="row" className={`${rowGridClass} text-ink-7`}>
            <span role="cell" className="truncate px-2 py-1.5 pl-6 text-[12px]">直下のファイル・上位に入らないディレクトリ</span>
            <span role="cell" className={numClass}>{fmtCapacityBytes(restBytes)}</span>
            <span role="cell" className={shareCellClass}><ShareBar share={bucketTotalBytes > 0 ? restBytes / bucketTotalBytes : 0} /></span>
            <span role="cell" className={deltaCellClass}>—</span>
            <span role="cell" className={objectCountCellClass}>{Math.max(0, restObjects).toLocaleString('ja-JP')}</span>
          </div>
        )}
      </div>
      {prefixes.length > INITIAL_VISIBLE_PREFIXES && (
        <button type="button" className="ghost mt-1.5 text-[11px]" onClick={() => setShowAll(value => !value)}>
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
      <div role="row" className={`${rowGridClass} transition-colors hover:bg-ink-0`}>
        <span role="cell" className="min-w-0 px-2 py-1.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <button
              type="button"
              className="flex min-w-0 items-baseline gap-1.5 text-left font-mono text-[12.5px] font-semibold text-ink-12"
              aria-expanded={open}
              aria-controls={trendId}
              title="推移を表示"
              onClick={onToggle}
            >
              <span aria-hidden className="w-3 shrink-0 text-ink-5">{open ? '▾' : '▸'}</span>
              <span className="truncate">{prefix.prefix}</span>
            </button>
            <Link
              className="shrink-0 text-[11px] text-link hover:text-link-hover"
              to={storageDirectoryHref(connectionId, bucket, prefix.prefix)}
              aria-label={`${prefix.prefix}を開く`}
            >
              開く →
            </Link>
          </span>
        </span>
        <span role="cell" className={`${numClass} font-semibold`}>{fmtCapacityBytes(prefix.totalBytes)}</span>
        <span role="cell" className={shareCellClass}><ShareBar share={share} /></span>
        <span role="cell" className={deltaCellClass}>
          {prefix.previous ? fmtCapacityDelta({ current: prefix.totalBytes, previous: prefix.previous.totalBytes }) : '—'}
        </span>
        <span role="cell" className={objectCountCellClass}>{prefix.objectCount.toLocaleString('ja-JP')}</span>
      </div>
      {open && (
        <div role="row" id={trendId} className="border-b border-rule px-2 pb-2">
          <div role="cell">
            <PrefixTrend
              connectionId={connectionId} bucket={bucket} prefix={prefix.prefix}
              days={days} intervalSeconds={intervalSeconds}
            />
          </div>
        </div>
      )}
    </>
  )
}

function ShareBar({ share }: { share: number }) {
  const percent = Math.min(100, Math.max(0, share * 100))
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 flex-1 bg-ink-1" aria-hidden>
        <span className="block h-full bg-ink-9" style={{ width: `${percent}%` }} />
      </span>
      <span className="w-12 text-right font-mono text-[11px] tabular-nums text-ink-7">{percent.toFixed(1)}%</span>
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

  if (error) return <p className="py-2 text-[11px] text-danger">{error}</p>
  if (!points) return <div className="h-[120px] pt-4 text-[12px] text-ink-7">推移を読み込み中…</div>
  if (points.length < 2) {
    return <div className="flex h-14 items-center justify-center text-[12px] text-ink-7">2回計測するとグラフを表示します</div>
  }
  return (
    <Suspense fallback={<div className="h-[120px] pt-4 text-[12px] text-ink-7">グラフを読み込み中…</div>}>
      <CapacityHistoryChart points={points} intervalSeconds={intervalSeconds} capacityBytes={null} label={`${bucket}/${prefix}`} />
    </Suspense>
  )
}
