import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { z } from 'zod'
import { api } from '../api/client'
import { S3List } from '../api/types'

interface Props {
  bucket: string
  prefix: string
  onSelectFile?: (key: string) => void
}

type ListResp = z.infer<typeof S3List>

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

export function S3Browser({ bucket, prefix, onSelectFile }: Props) {
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
    api.list(bucket, prefix, token)
      .then(setPage)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  // When bucket/prefix changes, reset paging back to the first page.
  useEffect(() => {
    setHistory([null])
    setPageIdx(0)
    load(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, prefix])

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

  if (error) return <p className="error">{error}</p>
  if (!page) return <p className="muted">{loading ? 'loading…' : ''}</p>

  return (
    <div>
      <table className="s3-list">
        <thead>
          <tr><th>Name</th><th>Size</th><th>Modified</th></tr>
        </thead>
        <tbody>
          {page.directories.map(d => {
            const tail = d.startsWith(prefix) ? d.slice(prefix.length) : d
            return (
              <tr
                key={d}
                className="s3-row dir"
                onClick={() =>
                  navigate(`/s3/${encodeURIComponent(bucket)}/${d}`)
                }
              >
                <td>📁 {tail}</td>
                <td>—</td>
                <td>—</td>
              </tr>
            )
          })}
          {page.files.map(f => {
            const tail = f.key.startsWith(prefix) ? f.key.slice(prefix.length) : f.key
            return (
              <tr
                key={f.key}
                className="s3-row file"
                onClick={() => onSelectFile?.(f.key)}
              >
                <td>📄 {tail}</td>
                <td>{fmtSize(f.size)}</td>
                <td>{f.lastModified?.slice(0, 10) ?? ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="pager">
        <button onClick={prev} disabled={pageIdx === 0 || loading}>◀ Prev</button>
        <span>page {pageIdx + 1}{page.nextContinuation ? '+' : ''}</span>
        <button onClick={next} disabled={!page.nextContinuation || loading}>
          Next ▶
        </button>
      </div>
    </div>
  )
}
