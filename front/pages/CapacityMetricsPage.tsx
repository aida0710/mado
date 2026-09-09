import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { CapacityHistory } from '../lib/api/types'
import { useAuth } from '../lib/auth-context'
import { ConnectionSwitcher } from '../components/ConnectionSwitcher'
import { ViewBreadcrumb } from '../components/ViewBreadcrumb'

const BucketCapacityChart = lazy(() => import('../components/storage/BucketCapacityChart'))
const DAYS = [7, 30, 90, 400] as const
const INTERVALS = [
  [21600, '6時間'], [43200, '12時間'], [86400, '24時間'],
  [259200, '3日'], [604800, '7日'],
] as const

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} ${units[unit]}`
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export default function CapacityMetricsPage({ connId }: { connId: string }) {
  const [params, setParams] = useSearchParams()
  const selectedBucket = params.get('bucket') ?? ''
  const parsedDays = Number(params.get('days'))
  const days = DAYS.includes(parsedDays as typeof DAYS[number]) ? parsedDays : 90
  const [buckets, setBuckets] = useState<string[]>([])
  const [history, setHistory] = useState<CapacityHistory | null>(null)
  const [loadedKey, setLoadedKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const requestRef = useRef(0)
  const auth = useAuth()
  const requestKey = `${connId}\n${selectedBucket}\n${days}`
  const loading = selectedBucket !== '' && loadedKey !== requestKey
  const canManage = !auth.enabled || (auth.user?.permissions.includes('connections:manage') ?? false)
  const canOperate = !auth.enabled || (auth.user?.permissions.includes('jobs:operate') ?? false)

  useEffect(() => {
    let alive = true
    api.buckets(connId).then(result => {
      if (!alive) return
      const names = result.buckets.map(bucket => bucket.name)
      setBuckets(names)
      if (!selectedBucket && names[0]) {
        setParams(previous => {
          const next = new URLSearchParams(previous)
          next.set('view', 'capacity')
          next.set('bucket', names[0])
          return next
        }, { replace: true })
      }
    }).catch(e => alive && setError((e as Error).message))
    return () => { alive = false }
  }, [connId, selectedBucket, setParams])

  const refreshHistory = useCallback(async () => {
    if (!selectedBucket) return
    const request = ++requestRef.current
    try {
      const next = await api.capacityHistory(connId, selectedBucket, days)
      if (request !== requestRef.current) return
      setHistory(next)
      setError(null)
    } catch (e) {
      if (request === requestRef.current) setError((e as Error).message)
    } finally {
      if (request === requestRef.current) setLoadedKey(`${connId}\n${selectedBucket}\n${days}`)
    }
  }, [connId, selectedBucket, days])

  useEffect(() => {
    if (!selectedBucket) return
    const request = ++requestRef.current
    api.capacityHistory(connId, selectedBucket, days)
      .then(next => {
        if (request !== requestRef.current) return
        setHistory(next)
        setError(null)
      })
      .catch(error => {
        if (request === requestRef.current) setError((error as Error).message)
      })
      .finally(() => {
        if (request === requestRef.current) setLoadedKey(requestKey)
      })
  }, [connId, selectedBucket, days, requestKey])

  const updateParam = (key: string, value: string) => setParams(previous => {
    const next = new URLSearchParams(previous)
    next.set('view', 'capacity')
    next.set(key, value)
    return next
  })

  const updateTracking = async (enabled: boolean, intervalSeconds: number) => {
    if (!selectedBucket) return
    setSaving(true)
    try {
      const result = await api.setCapacityTracking(connId, selectedBucket, enabled, intervalSeconds)
      setHistory(current => current ? { ...current, tracking: result.tracking } : current)
      setError(null)
    } catch (e) { setError((e as Error).message) }
    finally { setSaving(false) }
  }

  const scanNow = async () => {
    if (!selectedBucket) return
    setScanning(true)
    try {
      const { jobId } = await api.startScan(connId, selectedBucket, '')
      for (;;) {
        const job = await api.getJob(jobId)
        if (job.status === 'done') {
          const result = job.result as { partial?: boolean } | null
          if (result?.partial) throw new Error('走査が途中で終了したため、容量履歴には保存されませんでした')
          break
        }
        if (job.status === 'error' || job.status === 'canceled') throw new Error(job.error ?? '走査が完了しませんでした')
        await wait(1000)
      }
      await refreshHistory()
    } catch (e) { setError((e as Error).message) }
    finally { setScanning(false) }
  }

  const latest = history?.points.at(-1)
  const previous = history?.points.at(-2)
  const delta = latest && previous ? latest.totalBytes - previous.totalBytes : null
  const deltaRate = delta != null && previous && previous.totalBytes > 0
    ? delta / previous.totalBytes * 100 : null
  const usage = latest && history?.capacityBytes
    ? latest.totalBytes / history.capacityBytes * 100 : null

  return (
    <section>
      <div className="flex items-center justify-between gap-3">
        <ViewBreadcrumb connId={connId} label="容量メトリクス" href={`/storage/${encodeURIComponent(connId)}/?view=capacity`} />
        <ConnectionSwitcher />
      </div>
      <header className="mt-7 mb-6">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7">Bucket capacity</p>
        <h2 className="mt-1 text-[27px] font-semibold tracking-[-0.025em]">バケット容量メトリクス</h2>
        <p className="mt-2 max-w-[760px] text-[13px] text-ink-7">完全に走査できたバケット全体の容量だけを履歴化します。追跡を有効にするまで定期走査は始まりません。</p>
      </header>

      <div className="mb-5 grid gap-4 md:grid-cols-[minmax(220px,1fr)_auto]">
        <label className="text-[12px] font-semibold text-ink-8">バケット
          <select className="mt-1 block w-full border border-rule-strong bg-paper px-3 py-2 text-[13px]" value={selectedBucket} onChange={e => updateParam('bucket', e.target.value)}>
            {buckets.map(bucket => <option key={bucket} value={bucket}>{bucket}</option>)}
          </select>
        </label>
        <div className="flex items-end gap-2">
          {DAYS.map(value => <button key={value} type="button" className="ghost" aria-pressed={days === value} onClick={() => updateParam('days', String(value))}>{value === 400 ? '全期間' : `${value}日`}</button>)}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {loading && <p className="text-[13px] text-ink-7">読み込み中…</p>}
      {!loading && history && (
        <>
          <div className="grid gap-px border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="現在の容量" value={latest ? formatBytes(latest.totalBytes) : '—'} />
            <Metric label="前回から" value={delta == null ? '—' : `${delta >= 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}${deltaRate == null ? '' : ` (${deltaRate >= 0 ? '+' : ''}${deltaRate.toFixed(1)}%)`}`} />
            <Metric label="オブジェクト数" value={latest ? latest.objectCount.toLocaleString('ja-JP') : '—'} />
            <Metric label={usage == null ? '最終取得' : '容量上限に対して'} value={usage == null ? (latest ? new Date(latest.collectedAt).toLocaleString('ja-JP') : '—') : `${usage.toFixed(1)}%`} />
          </div>

          <div className="mt-7 border-t border-rule pt-5">
            {history.points.length >= 2 ? (
              <Suspense fallback={<p className="text-[13px] text-ink-7">グラフを読み込み中…</p>}>
                <BucketCapacityChart
                  points={history.points}
                  intervalSeconds={history.tracking.intervalSeconds}
                  capacityBytes={history.capacityBytes}
                />
              </Suspense>
            ) : (
              <div className="py-16 text-center">
                <p className="font-semibold">履歴はまだありません</p>
                <p className="mt-1 text-[13px] text-ink-7">2回以上の完全走査が完了すると推移を表示します。</p>
              </div>
            )}
          </div>

          <div className="mt-7 flex flex-wrap items-end gap-3 border-t border-rule pt-5">
            <label className="text-[12px] font-semibold text-ink-8">計測間隔
              <select className="mt-1 block border border-rule-strong bg-paper px-3 py-2" disabled={!canManage || saving} value={history.tracking.intervalSeconds} onChange={e => void updateTracking(history.tracking.enabled, Number(e.target.value))}>
                {INTERVALS.map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}
              </select>
            </label>
            {canManage && <button type="button" className="ghost" disabled={saving} onClick={() => void updateTracking(!history.tracking.enabled, history.tracking.intervalSeconds)}>{history.tracking.enabled ? '定期計測を停止' : '定期計測を有効化'}</button>}
            {canOperate && <button type="button" className="ghost" disabled={scanning} onClick={() => void scanNow()}>{scanning ? '走査中…' : '今すぐ計測'}</button>}
            <span className="text-[12px] text-ink-7">{history.tracking.enabled ? `追跡中${history.tracking.nextRunAt ? ` · 次回 ${new Date(history.tracking.nextRunAt).toLocaleString('ja-JP')}` : ''}` : '定期計測は停止中'}</span>
          </div>
          {history.tracking.lastError && <p className="mt-3 text-[12px] text-danger">前回: {history.tracking.lastError}</p>}
          <p className="mt-6"><Link className="text-link hover:text-link-hover" to={`/storage/${encodeURIComponent(connId)}/${encodeURIComponent(selectedBucket)}/`}>バケットを開く →</Link></p>
        </>
      )}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="bg-paper px-5 py-4"><p className="text-[10.5px] uppercase tracking-[0.16em] text-ink-7">{label}</p><p className="mt-1 font-mono text-[19px] font-semibold tabular-nums">{value}</p></div>
}
