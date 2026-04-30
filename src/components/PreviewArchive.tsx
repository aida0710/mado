import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { z } from 'zod'
import { TarPreview } from '../api/types'

type Resp = z.infer<typeof TarPreview>

export function PreviewArchive({ bucket, k }: { bucket: string; k: string }) {
  const [data, setData] = useState<Resp | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.tarPreview(bucket, k)
      .then(r => { if (!cancelled) setData(r) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [bucket, k])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">loading entries…</p>

  return (
    <div>
      {data.truncated && (
        <p className="muted">
          先頭 {data.entries.length} 件のみ表示
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
    </div>
  )
}
