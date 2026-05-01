import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { Connection } from '../api/types'

export default function StorageLanding() {
  const [connections, setConnections] = useState<Connection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    api.listConnections()
      .then(list => {
        setConnections(list)
        if (list.length === 1) navigate(`/storage/${list[0].id}/`, { replace: true })
      })
      .catch(e => setError((e as Error).message))
  }, [navigate])

  if (error) return <p className="error">{error}</p>
  if (!connections) return <p className="muted">読み込み中…</p>
  if (connections.length === 0) {
    return (
      <div className="empty-state">
        <h2>接続がまだありません</h2>
        <p className="muted">設定ページから接続を追加してください。</p>
        <Link className="empty-state__cta" to="/connections">接続を追加</Link>
      </div>
    )
  }
  return (
    <div className="page">
      <div className="page-head">
        <h2>接続を選択</h2>
        <Link className="ghost" to="/connections">設定</Link>
      </div>
      <ul className="connections-list">
        {connections.map(c => (
          <li key={c.id} className="conn-row">
            <Link to={`/storage/${c.id}/`} style={{ textDecoration: 'none', color: 'inherit', flex: 1 }}>
              <strong>{c.name}</strong>
              <div className="conn-row__meta">
                {c.endpoint} · {c.region} · {c.accessKeyIdMasked}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
