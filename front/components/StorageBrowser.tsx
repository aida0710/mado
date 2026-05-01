import { useEffect, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../api/client'
import { StorageList } from '../api/types'
import { fmtSize } from '../lib/format'

interface Props {
  connId: string
  bucket: string
  prefix: string
  onSelectFile?: (key: string) => void
}

type ListResp = z.infer<typeof StorageList>

export function StorageBrowser({ connId, bucket, prefix, onSelectFile }: Props) {
  const navigate = useNavigate()
  const [page, setPage] = useState<ListResp | null>(null)
  // history of continuation tokens. history[0] is always null (= page 1).
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

  // When connection/bucket/prefix changes, reset paging back to the first page.
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
  if (!page) return <p className="muted">{loading ? 'loading…' : ''}</p>

  return (
    <div>
      <table className="storage-list">
        <thead>
          <tr>
            <th>Name</th>
            <th className="col-size">Size</th>
            <th className="col-modified">Modified</th>
          </tr>
        </thead>
        <tbody>
          {page.directories.map(d => {
            const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
            const go = () => navigate(`/storage/${connId}/${encodeURIComponent(bucket)}/${d}`)
            return (
              <tr
                key={d}
                className="storage-row dir"
                role="link"
                tabIndex={0}
                onClick={go}
                onKeyDown={activate(go)}
              >
                <td>📁 {tail}</td>
                <td className="col-size">—</td>
                <td className="col-modified">—</td>
              </tr>
            )
          })}
          {page.files.map(f => {
            const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
            const select = () => onSelectFile?.(f.key)
            return (
              <tr
                key={f.key}
                className="storage-row file"
                role="button"
                tabIndex={0}
                onClick={select}
                onKeyDown={activate(select)}
              >
                <td>📄 {tail}</td>
                <td className="col-size">{fmtSize(f.size)}</td>
                <td className="col-modified">{f.lastModified?.slice(0, 10) ?? ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="pager">
        <button onClick={prev} disabled={pageIdx === 0 || loading}>← Prev</button>
        <span>page {pageIdx + 1}{page.nextContinuation ? '+' : ''}</span>
        <button onClick={next} disabled={!page.nextContinuation || loading}>
          Next →
        </button>
      </div>
    </div>
  )
}
