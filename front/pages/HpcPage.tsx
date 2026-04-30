import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { HpcMetric } from '../api/types'
import { HpcCard } from '../components/HpcCard'

export default function HpcPage() {
  const [metrics, setMetrics] = useState<HpcMetric[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    api.hpc()
      .then(setMetrics)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Group by category, preserving the server's category-first ordering.
  const grouped = useMemo(() => {
    const map = new Map<string, HpcMetric[]>()
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
        <h2>スパコン</h2>
        <button className="ghost" onClick={refresh} disabled={loading}>
          {loading ? '...' : 'refresh'}
        </button>
        <span className="muted">直近 1 時間のデータ</span>
      </header>
      {error && <p className="error">{error}</p>}
      {!loading && !error && metrics.length === 0 && (
        <p className="muted">
          直近 1 時間に push されたメトリクスがありません。HPC 側 cron の動作を確認してください。
        </p>
      )}
      {grouped.map(([category, ms]) => (
        <section key={category} className="hpc-category">
          <h3 className="hpc-category__title">{category}</h3>
          <div className="hpc-grid">
            {ms.map(m => (
              <HpcCard key={`${m.host}/${m.command}`} m={m} />
            ))}
          </div>
        </section>
      ))}
    </section>
  )
}
