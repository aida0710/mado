import { useEffect, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../lib/api/client'
import { StorageList } from '../lib/api/types'
import { fmtSize } from '../lib/format'
import { encPath, encSegment } from '../lib/route'

interface Props {
  connId: string
  bucket: string
  prefix: string
  onSelectFile?: (key: string) => void
}

type ListResp = z.infer<typeof StorageList>

const headThClass =
  'border-b border-ink-2 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-ink-7'
const tdNameClass =
  'max-w-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-ink-1 px-2 py-2'
const tdNumClass =
  'w-px whitespace-nowrap border-b border-ink-1 px-2 py-2 text-right tabular-nums text-ink-7'
const rowClass =
  'cursor-pointer transition-colors hover:bg-ink-0 focus-visible:bg-ink-1'

export function StorageBrowser({ connId, bucket, prefix, onSelectFile }: Props) {
  const navigate = useNavigate()
  const [page, setPage] = useState<ListResp | null>(null)
  // continuation トークンの履歴。history[0] は常に null (= 1ページ目)。
  const [history, setHistory] = useState<Array<string | null>>([null])
  const [pageIdx, setPageIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = (token: string | null) => {
    setLoading(true)
    setError(null)
    api.list(connId, bucket, prefix, token)
      .then(setPage)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  // 接続/バケット/プレフィックスが変わったときにページングを先頭ページにリセットする。
  useEffect(() => {
    setHistory([null])
    setPageIdx(0)
    load(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, bucket, prefix])

  const next = () => {
    if (!page?.nextContinuation) return
    const token = page.nextContinuation
    setHistory(h => [...h, token])
    setPageIdx(i => i + 1)
    load(token)
  }
  const prev = () => {
    if (pageIdx === 0) return
    const newIdx = pageIdx - 1
    setPageIdx(newIdx)
    load(history[newIdx])
  }

  const activate = (fn: () => void) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  }

  if (error) return <p className="error">{error}</p>
  if (!page) return <p className="text-ink-7">{loading ? 'loading…' : ''}</p>

  return (
    <div>
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={headThClass}>Name</th>
            <th className={`${headThClass} text-right`}>Size</th>
            <th className={`${headThClass} text-right`}>Modified</th>
          </tr>
        </thead>
        <tbody>
          {page.directories.map(d => {
            const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
            const go = () => navigate(`/storage/${encSegment(connId)}/${encSegment(bucket)}/${encPath(d)}`)
            return (
              <tr
                key={d}
                className={rowClass}
                role="link"
                tabIndex={0}
                onClick={go}
                onKeyDown={activate(go)}
              >
                <td className={`${tdNameClass} font-semibold`}>📁 {tail}</td>
                <td className={tdNumClass}>—</td>
                <td className={tdNumClass}>—</td>
              </tr>
            )
          })}
          {page.files.map(f => {
            const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
            const select = () => onSelectFile?.(f.key)
            return (
              <tr
                key={f.key}
                className={rowClass}
                role="button"
                tabIndex={0}
                onClick={select}
                onKeyDown={activate(select)}
              >
                <td className={tdNameClass}>📄 {tail}</td>
                <td className={tdNumClass}>{fmtSize(f.size)}</td>
                <td className={tdNumClass}>{f.lastModified?.slice(0, 10) ?? ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="flex items-center justify-center gap-3 py-3 tabular-nums">
        <button
          className="cursor-pointer rounded-2 border border-ink-3 bg-paper px-3 py-1 transition-colors hover:bg-ink-1 hover:border-ink-5 disabled:cursor-default disabled:opacity-40"
          onClick={prev}
          disabled={pageIdx === 0 || loading}
        >
          ← Prev
        </button>
        <span>page {pageIdx + 1}{page.nextContinuation ? '+' : ''}</span>
        <button
          className="cursor-pointer rounded-2 border border-ink-3 bg-paper px-3 py-1 transition-colors hover:bg-ink-1 hover:border-ink-5 disabled:cursor-default disabled:opacity-40"
          onClick={next}
          disabled={!page.nextContinuation || loading}
        >
          Next →
        </button>
      </div>
    </div>
  )
}
