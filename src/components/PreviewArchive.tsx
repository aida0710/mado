import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { z } from 'zod'
import { TarPreview } from '../api/types'

type Resp = z.infer<typeof TarPreview>

const PAGE_SIZE = 100

export function PreviewArchive({ bucket, k }: { bucket: string; k: string }) {
  const [data, setData] = useState<Resp | null>(null)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Reset to page 1 whenever the file changes.
  useEffect(() => { setOffset(0) }, [bucket, k])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.tarPreview(bucket, k, { limit: PAGE_SIZE, offset })
      .then(r => { if (!cancelled) setData(r) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bucket, k, offset])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">loading entries…</p>

  const start = data.offset + 1
  const end = data.offset + data.entries.length
  const page = Math.floor(data.offset / PAGE_SIZE) + 1

  return (
    <div>
      {data.truncated && (
        <p className="muted">
          バイト上限に到達しました。これ以降は読み込めません。
        </p>
      )}
      <table className="archive-list">
        <thead><tr><th>Name</th><th>Size</th></tr></thead>
        <tbody>
          {data.entries.map(e => (
            <tr key={e.name}>
              <td>{e.name}</td>
              <td>{e.size}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager">
        <button
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          disabled={offset === 0 || loading}
        >◀ Prev</button>
        <span>
          {data.entries.length > 0
            ? `${start}–${end}`
            : 'no entries'}
          {' / page '}{page}
          {data.hasMore || data.truncated ? '+' : ''}
        </span>
        <button
          onClick={() => setOffset(offset + PAGE_SIZE)}
          disabled={!data.hasMore || data.truncated || loading}
        >Next ▶</button>
      </div>
    </div>
  )
}
