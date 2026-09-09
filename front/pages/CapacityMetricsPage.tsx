import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { CapacityBucketHistory, CapacityOverview } from '../lib/api/types'
import { useAuth } from '../lib/auth-context'
import { useConnection } from '../lib/connectionContext'
import { ConnectionSwitcher } from '../components/ConnectionSwitcher'
import { ViewBreadcrumb } from '../components/ViewBreadcrumb'

const BucketCapacityChart = lazy(() => import('../components/storage/BucketCapacityChart'))
const DAYS = [7, 30, 90, 400] as const

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} ${units[unit]}`
}

export default function CapacityMetricsPage({ connId }: { connId: string }) {
  const [params, setParams] = useSearchParams()
  const parsedDays = Number(params.get('days'))
  const days = DAYS.includes(parsedDays as typeof DAYS[number]) ? parsedDays : 90
  const [overview, setOverview] = useState<CapacityOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const auth = useAuth()
  const connection = useConnection()
  const canManage = !auth.enabled || (auth.user?.permissions.includes('connections:manage') ?? false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setOverview(await api.capacityOverview(connId, days))
      setError(null)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }, [connId, days])

  useEffect(() => {
    let active = true
    api.capacityOverview(connId, days)
      .then(result => {
        if (!active) return
        setOverview(result)
        setError(null)
      })
      .catch(cause => { if (active) setError((cause as Error).message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [connId, days])

  const updateDays = (value: number) => {
    setLoading(true)
    setParams(previous => {
      const next = new URLSearchParams(previous)
      next.set('view', 'capacity')
      next.set('days', String(value))
      next.delete('bucket')
      return next
    })
  }

  const scanAll = async () => {
    setScanning(true)
    setNotice(null)
    try {
      const result = await api.startCapacityScan(connId)
      setNotice(`${result.jobs.length.toLocaleString('ja-JP')}バケットの計測を開始しました。完了すると順次反映されます。`)
      setError(null)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setScanning(false)
    }
  }

  const measured = overview?.buckets.flatMap(bucket => bucket.points.at(-1) ?? []) ?? []
  const totalBytes = measured.reduce((sum, point) => sum + point.totalBytes, 0)
  const totalObjects = measured.reduce((sum, point) => sum + point.objectCount, 0)
  const measuredCount = measured.length
  const bucketCount = overview?.buckets.length ?? 0

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <ViewBreadcrumb connId={connId} label="容量メトリクス" href={`/storage/${encodeURIComponent(connId)}/?view=capacity`} />
        <ConnectionSwitcher />
      </div>
      <header className="mt-7 mb-5">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">Bucket capacity</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[27px] font-semibold tracking-[-0.025em]">バケット容量メトリクス</h2>
            <p className="mt-1 text-[13px] text-ink-7">このコネクションにある全バケットの完全走査結果をまとめて表示します。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ghost" disabled={loading} onClick={() => void refresh()}>表示を更新</button>
            {canManage && (
              <button type="button" className="ghost" disabled={scanning || !connection.scanEnabled || connection.capacityMetricsEnabled === false} onClick={() => void scanAll()}>
                {scanning ? '開始中…' : '今すぐ全バケットを計測'}
              </button>
            )}
          </div>
        </div>
      </header>

      {overview && (
        <div className="mb-5 grid gap-px border border-rule bg-rule sm:grid-cols-3">
          <Metric label="全バケットの容量" value={measuredCount ? formatBytes(totalBytes) : '—'} />
          <Metric label="全バケットのオブジェクト数" value={measuredCount ? totalObjects.toLocaleString('ja-JP') : '—'} />
          <Metric label="集計範囲" value={`${measuredCount.toLocaleString('ja-JP')} / ${bucketCount.toLocaleString('ja-JP')} バケット`} />
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-y border-rule py-3">
        <div className="flex gap-2">
          {DAYS.map(value => (
            <button key={value} type="button" className="ghost" aria-pressed={days === value} onClick={() => updateDays(value)}>
              {value === 400 ? '全期間' : `${value}日`}
            </button>
          ))}
        </div>
        {overview && (
          <p className="text-[12px] text-ink-7">
            {overview.tracking.enabled
              ? `${Math.round(overview.tracking.intervalSeconds / 3600)}時間ごとに全バケットを計測`
              : '定期計測は停止中'}
            {canManage && <> · <Link className="text-link hover:text-link-hover" to={`/settings/connections/${encodeURIComponent(connId)}`}>コネクション設定</Link></>}
          </p>
        )}
      </div>

      {notice && <p className="mb-4 border border-rule bg-ink-1 px-3 py-2 text-[12px]">{notice}</p>}
      {error && <p className="error">{error}</p>}
      {loading && !overview && <p className="text-[13px] text-ink-7">読み込み中…</p>}
      {!loading && overview?.buckets.length === 0 && <p className="empty-state">バケットが見つかりません。</p>}

      {overview && (
        <div className="space-y-4" aria-busy={loading}>
          {overview.buckets.map(bucket => (
            <BucketMetrics
              key={bucket.bucket}
              connId={connId}
              history={bucket}
              intervalSeconds={overview.tracking.intervalSeconds}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function BucketMetrics({ connId, history, intervalSeconds }: {
  connId: string
  history: CapacityBucketHistory
  intervalSeconds: number
}) {
  const latest = history.points.at(-1)
  const previous = history.points.at(-2)
  const delta = latest && previous ? latest.totalBytes - previous.totalBytes : null
  const deltaRate = delta != null && previous && previous.totalBytes > 0
    ? delta / previous.totalBytes * 100 : null
  return (
    <article className="border border-rule-strong bg-paper px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate font-mono text-[14px] font-semibold" title={history.bucket}>{history.bucket}</h3>
        <Link className="shrink-0 text-[11px] text-link hover:text-link-hover" to={`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(history.bucket)}/`}>開く →</Link>
      </div>
      <div className="grid gap-px bg-rule sm:grid-cols-4">
        <CompactMetric label="現在の容量" value={latest ? formatBytes(latest.totalBytes) : '—'} />
        <CompactMetric label="前回から" value={delta == null ? '—' : `${delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}${deltaRate == null ? '' : ` (${deltaRate >= 0 ? '+' : ''}${deltaRate.toFixed(1)}%)`}`} />
        <CompactMetric label="オブジェクト数" value={latest ? latest.objectCount.toLocaleString('ja-JP') : '—'} />
        <CompactMetric label="最終取得" value={latest ? new Date(latest.collectedAt).toLocaleString('ja-JP') : '—'} />
      </div>
      {history.lastError && <p className="mt-2 text-[11px] text-danger">{history.lastError}</p>}
      <div className="mt-2 border-t border-rule pt-1">
        {history.points.length >= 2 ? (
          <Suspense fallback={<div className="h-[120px] pt-4 text-[12px] text-ink-7">グラフを読み込み中…</div>}>
            <BucketCapacityChart points={history.points} intervalSeconds={intervalSeconds} capacityBytes={null} label={history.bucket} />
          </Suspense>
        ) : (
          <div className="flex h-14 items-center justify-center text-[12px] text-ink-7">2回計測するとグラフを表示します</div>
        )}
      </div>
    </article>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-paper px-4 py-3"><p className="text-[10px] uppercase tracking-[0.14em] text-ink-7">{label}</p><p className="mt-0.5 font-mono text-[17px] font-semibold tabular-nums">{value}</p></div>
}

function CompactMetric({ label, value }: { label: string; value: string }) {
  return <div className="bg-paper px-3 py-2"><p className="text-[9.5px] uppercase tracking-[0.12em] text-ink-7">{label}</p><p className="mt-0.5 truncate font-mono text-[13px] font-semibold tabular-nums" title={value}>{value}</p></div>
}
