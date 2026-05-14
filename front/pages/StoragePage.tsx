import { lazy, Suspense, useEffect, useReducer } from 'react'
import { Route, Routes, Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection } from '../lib/api/types'
import { ConnectionContext } from '../lib/connectionContext'
import StorageIndex from './StorageIndex'
import StorageBucket from './StorageBucket'

// README 編集ページは Monaco エディタを抱えるので別チャンクに切り出す。
// 編集ボタンを押さないユーザに ~1MB のロードを発生させないため。
const ReadmeEditPage = lazy(() => import('./ReadmeEditPage'))

interface Props { connId: string }

interface State {
  connection: Connection | null
  error: string | null
  loading: boolean
}

type Action =
  | { type: 'startLoad' }
  | { type: 'loadOk'; conn: Connection | null }
  | { type: 'loadErr'; error: string }
  | { type: 'notFound'; connId: string }

const initial: State = { connection: null, error: null, loading: true }

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'startLoad':
      return { ...s, loading: true, error: null }
    case 'loadOk':
      return { connection: a.conn, error: null, loading: false }
    case 'loadErr':
      return { ...s, error: a.error, loading: false }
    case 'notFound':
      return { connection: null, error: `接続が見つかりません: ${a.connId}`, loading: false }
  }
}

export default function StoragePage({ connId }: Props) {
  const [state, dispatch] = useReducer(reducer, initial)
  const { connection, error, loading } = state

  useEffect(() => {
    dispatch({ type: 'startLoad' })
    api.listConnections()
      .then(list => {
        const found = list.find(c => c.id === connId) ?? null
        if (found) dispatch({ type: 'loadOk', conn: found })
        else dispatch({ type: 'notFound', connId })
      })
      .catch(e => dispatch({ type: 'loadErr', error: (e as Error).message }))
  }, [connId])

  if (loading) {
    return <p className="text-[13px] text-ink-7">読み込み中…</p>
  }
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
      <Suspense fallback={<p className="text-[13px] text-ink-7">読み込み中…</p>}>
        <Routes>
          <Route path="/"                       element={<StorageIndex  connId={connId} />} />
          {/* edit-readme は固定セグメントから始まるので :bucket/* より specificity が高く、
              :bucket = 'edit-readme' という偶発的衝突は発生しない。               */}
          <Route path="edit-readme/:bucket/*"   element={<ReadmeEditPage connId={connId} />} />
          <Route path=":bucket/*"               element={<StorageBucket  connId={connId} />} />
        </Routes>
      </Suspense>
    </ConnectionContext.Provider>
  )
}
