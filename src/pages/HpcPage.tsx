import { useCallback, useEffect, useState } from 'react'
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

  return (
    <section>
      <header className="page-head">
        <h2>スパコン</h2>
        <button className="ghost" onClick={refresh} disabled={loading}>
          {loading ? '...' : 'refresh'}
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      <div className="hpc-grid">
        {metrics.map(m => (
          <HpcCard key={`${m.host}/${m.command}`} m={m} />
        ))}
        {!loading && !error && metrics.length === 0 && (
          <p className="muted">
            まだメトリクスがありません。HPC 側 cron からの push をお待ちください。
          </p>
        )}
      </div>
    </section>
  )
}
