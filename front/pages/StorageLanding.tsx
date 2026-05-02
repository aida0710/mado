import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'

export default function StorageLanding() {
  const [connections, setConnections] = useState<Connection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.listConnections()
      .then(list => {
        setConnections(list)
        if (list.length === 1) navigate(`/storage/${encodeURIComponent(list[0].id)}/`, { replace: true })
      })
      .catch(e => setError((e as Error).message))
  }, [navigate])

  if (error) return <p className="error">{error}</p>
  if (!connections) return <p className="text-ink-7">読み込み中…</p>
  if (connections.length === 0) {
    return (
      <div className="empty-state">
        <h2>接続がまだありません</h2>
        <p className="text-ink-7">設定ページから接続を追加してください。</p>
        <Link className="empty-state__cta" to="/connections">接続を追加</Link>
      </div>
    )
  }
  return (
    <div>
      <div className="page-head">
        <h2>接続を選択</h2>
        <Link className="ghost" to="/connections">設定</Link>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {connections.map(c => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-4 rounded-3 border border-ink-2 bg-paper p-3 transition-colors hover:border-ink-3"
          >
            <Link
              to={`/storage/${encodeURIComponent(c.id)}/`}
              className="flex-1 text-inherit no-underline"
            >
              <strong>{c.name}</strong>
              <div className="mt-1 font-mono text-xs text-ink-7">
                {c.endpoint} · {c.region} · {c.accessKeyIdMasked}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
