import type { Metric } from '../api/types'
import { fmtAgo } from '../lib/format'

export function MetricCard({ m }: { m: Metric }) {
  return (
    <article className="overflow-hidden rounded-3 border border-ink-2 bg-paper transition-colors hover:border-ink-3">
      <header className="flex min-w-0 items-baseline gap-2 border-b border-ink-2 px-3 py-2">
        <span className="overflow-hidden text-ellipsis whitespace-nowrap font-semibold tracking-[-0.01em]">
          {m.host}
        </span>
        <span className="font-mono text-xs text-ink-7">{m.command}</span>
        <time
          className="ml-auto whitespace-nowrap text-xs tabular-nums text-ink-7"
          dateTime={m.collected_at}
        >
          {fmtAgo(m.collected_at)}
        </time>
      </header>
      <pre className="m-0 max-h-60 overflow-auto whitespace-pre bg-ink-0 px-3 py-2 tabular-nums">
        {m.output}
      </pre>
    </article>
  )
}
