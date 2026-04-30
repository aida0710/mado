import type { HpcMetric } from '../api/types'

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60)  return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m}min ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function HpcCard({ m }: { m: HpcMetric }) {
  return (
    <article className="hpc-card">
      <header className="hpc-card__head">
        <span className="hpc-card__host">{m.host}</span>
        <span className="hpc-card__cmd">/ {m.command}</span>
        <span className="hpc-card__time">{ago(m.collected_at)}</span>
      </header>
      <pre className="hpc-card__body">{m.output}</pre>
    </article>
  )
}
