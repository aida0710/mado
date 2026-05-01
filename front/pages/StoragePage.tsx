import { useEffect, useState } from 'react'
import { Route, Routes, Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'
import { ConnectionContext } from '../lib/connectionContext'
import StorageIndex from './StorageIndex'
import StorageBucket from './StorageBucket'

interface Props { connId: string }

export default function StoragePage({ connId }: Props) {
  const [connection, setConnection] = useState<Connection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.listConnections()
      .then(list => {
        const found = list.find(c => c.id === connId) ?? null
        setConnection(found)
        if (!found) setError(`接続が見つかりません: ${connId}`)
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [connId])

  if (loading) return <p className="text-ink-7">読み込み中…</p>
  if (error || !connection) {
    return (
      <div className="empty-state">
        <h2>{error ?? 'unknown'}</h2>
        <Link className="empty-state__cta" to="/storage">接続一覧へ</Link>
      </div>
    )
  }
  return (
    <ConnectionContext.Provider value={connection}>
      <Routes>
        <Route path="/"         element={<StorageIndex  connId={connId} />} />
        <Route path=":bucket/*" element={<StorageBucket connId={connId} />} />
      </Routes>
    </ConnectionContext.Provider>
  )
}
