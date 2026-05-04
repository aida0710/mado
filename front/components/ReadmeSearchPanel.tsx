import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import { encPath } from '../lib/route'

interface Props {
  connId: string
}

interface Hit {
  bucket: string
  prefix: string
  editor: string
  edited_at: string
  size_bytes: number
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('ja-JP')
}

// 接続内の README 全文検索パネル。input ≥ 2 文字で debounce してリクエスト。
// 結果は最新版のみ対象、クリックでその prefix へ遷移する。
export function ReadmeSearchPanel({ connId }: Props) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // debounce 250ms。連打しても 1 リクエストに収まる。
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const t = setTimeout(() => {
      api.readmesSearch(connId, q.trim())
        .then(r => { if (!cancelled) setHits(r.hits) })
        .catch((e: Error) => { if (!cancelled) setError(e.message) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(t) }
  }, [connId, q])

  return (
    <section className="mt-2 mb-2">
      <div className="flex items-center gap-2">
        <input
          type="search"
          className="flex-1 max-w-[480px] rounded-2 border border-ink-3 bg-paper px-3 py-1.5 text-sm"
          placeholder="README 全文検索 (2 文字以上)"
          value={q}
          onChange={e => setQ(e.target.value)}
          aria-label="README 全文検索"
        />
        {loading && <span className="text-xs text-ink-7">…</span>}
      </div>

      {error && <p className="error mt-2">{error}</p>}

      {hits !== null && hits.length === 0 && !loading && !error && (
        <p className="mt-2 text-xs text-ink-7">ヒットなし。</p>
      )}

      {hits !== null && hits.length > 0 && (
        <ul className="m-0 mt-2 list-none p-0">
          {hits.map(h => {
            const to =
              `/storage/${encodeURIComponent(connId)}` +
              `/${encodeURIComponent(h.bucket)}/${encPath(h.prefix)}`
            return (
              <li key={`${h.bucket}/${h.prefix}`} className="border-b border-ink-1 py-2">
                <Link to={to} className="text-ink-11 no-underline hover:underline">
                  <span className="font-mono text-xs text-ink-7">{h.bucket}/</span>
                  <span className="font-mono text-xs">{h.prefix || '(root)'}</span>
                </Link>
                <div className="text-[11px] text-ink-7 tabular-nums">
                  last by {h.editor} · {fmtTime(h.edited_at)}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
