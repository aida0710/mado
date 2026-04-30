import type { HpcMetric } from '../api/types'
import { fmtAgo } from '../lib/format'

export function HpcCard({ m }: { m: HpcMetric }) {
  return (
    <article className="hpc-card">
      <header className="hpc-card__head">
        <span className="hpc-card__host">{m.host}</span>
        <span className="hpc-card__cmd">{m.command}</span>
        <time className="hpc-card__time" dateTime={m.collected_at}>
          {fmtAgo(m.collected_at)}
        </time>
      </header>
      <pre className="hpc-card__body">{m.output}</pre>
    </article>
  )
}
