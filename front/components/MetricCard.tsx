import type { Metric } from '../api/types'
import { fmtAgo } from '../lib/format'

export function MetricCard({ m }: { m: Metric }) {
  return (
    <article className="metric-card">
      <header className="metric-card__head">
        <span className="metric-card__host">{m.host}</span>
        <span className="metric-card__cmd">{m.command}</span>
        <time className="metric-card__time" dateTime={m.collected_at}>
          {fmtAgo(m.collected_at)}
        </time>
      </header>
      <pre className="metric-card__body">{m.output}</pre>
    </article>
  )
}
