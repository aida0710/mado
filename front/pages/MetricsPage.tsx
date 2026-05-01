import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Metric } from '../lib/api/types'
import { MetricCard } from '../components/MetricCard'
import { MetricsHelpModal } from '../components/MetricsHelpModal'
import { isEnabled, useFlags } from '../lib/flagsContext'

function formatTime(d: Date): string {
  return d.toLocaleTimeString('ja-JP', { hour12: false })
}

export default function MetricsPage() {
  const { flags } = useFlags()
  const enabled = isEnabled(flags, 'metrics')
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    api.metrics()
      .then(rows => {
        setMetrics(rows)
        setFetchedAt(new Date())
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (enabled) refresh()
  }, [enabled, refresh])

  if (flags && !enabled) {
    return (
      <div className="empty-state">
        <h2>Metrics is disabled</h2>
        <p className="text-ink-7">設定ページから有効化できます。</p>
        <Link className="empty-state__cta" to="/connections">設定を開く</Link>
      </div>
    )
  }

  // サーバーのカテゴリ優先順位を維持しながらカテゴリ別にグループ化する。
  const grouped = useMemo(() => {
    const map = new Map<string, Metric[]>()
    for (const m of metrics) {
      const arr = map.get(m.category) ?? []
      arr.push(m)
      map.set(m.category, arr)
    }
    return [...map.entries()]
  }, [metrics])

  return (
    <section>
      <header className="page-head">
        <h2>Metrics</h2>
        <button className="ghost" onClick={refresh} disabled={loading}>
          {loading ? '...' : 'refresh'}
        </button>
        <span className="text-ink-7">直近 1 時間のデータ</span>
        {fetchedAt && (
          <span className="text-ink-7">最終更新 {formatTime(fetchedAt)}</span>
        )}
        <button
          type="button"
          className="ghost ml-auto"
          onClick={() => setHelpOpen(true)}
          aria-label="ヘルプを開く"
        >
          ?
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {!loading && !error && metrics.length === 0 && (
        <p className="text-ink-7">
          直近 1 時間に push されたメトリクスがありません。送信側 cron の動作を確認してください。
        </p>
      )}
      {grouped.map(([category, ms]) => (
        <section key={category} className="mt-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-ink-7">
            {category}
          </h3>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(380px,1fr))]">
            {ms.map(m => (
              <MetricCard key={`${m.host}/${m.command}`} m={m} />
            ))}
          </div>
        </section>
      ))}
      {helpOpen && <MetricsHelpModal onClose={() => setHelpOpen(false)} />}
    </section>
  )
}
