import { useCallback, useEffect, useReducer } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection, ConnectionCreateInput, ConnectionUpdateInput } from '../lib/api/types'
import { ConnectionForm } from '../components/ConnectionForm'
import { ConnectionDeleteConfirm } from '../components/ConnectionDeleteConfirm'
import { About } from '../components/About'

const sectionTitleClass =
  'm-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

interface State {
  connections: Connection[]
  loading: boolean
  error: string | null
  adding: boolean
  editing: Connection | null
  deleting: Connection | null
}

type Action =
  | { type: 'startLoad' }
  | { type: 'loadOk'; rows: Connection[] }
  | { type: 'loadErr'; error: string }
  | { type: 'openAdd' }
  | { type: 'closeAdd' }
  | { type: 'openEdit'; conn: Connection }
  | { type: 'closeEdit' }
  | { type: 'openDelete'; conn: Connection }
  | { type: 'closeDelete' }

const initial: State = {
  connections: [],
  loading: true,
  error: null,
  adding: false,
  editing: null,
  deleting: null,
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'startLoad':
      return { ...s, loading: true, error: null }
    case 'loadOk':
      return { ...s, loading: false, connections: a.rows }
    case 'loadErr':
      return { ...s, loading: false, error: a.error }
    case 'openAdd':
      return { ...s, adding: true }
    case 'closeAdd':
      return { ...s, adding: false }
    case 'openEdit':
      return { ...s, editing: a.conn }
    case 'closeEdit':
      return { ...s, editing: null }
    case 'openDelete':
      return { ...s, deleting: a.conn }
    case 'closeDelete':
      return { ...s, deleting: null }
  }
}

export default function ConnectionsPage() {
  const [state, dispatch] = useReducer(reducer, initial)
  const { connections, loading, error, adding, editing, deleting } = state

  const refresh = useCallback(() => {
    dispatch({ type: 'startLoad' })
    api.listConnections()
      .then(rows => dispatch({ type: 'loadOk', rows }))
      .catch((e: Error) => dispatch({ type: 'loadErr', error: e.message }))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async (input: ConnectionCreateInput) => {
    await api.createConnection(input)
    dispatch({ type: 'closeAdd' })
    refresh()
  }
  const handleUpdate = (id: string) => async (input: ConnectionUpdateInput) => {
    await api.updateConnection(id, input)
    dispatch({ type: 'closeEdit' })
    refresh()
  }
  const handleDelete = (id: string) => async () => {
    await api.deleteConnection(id)
    dispatch({ type: 'closeDelete' })
    refresh()
  }

  return (
    <div>
      <header className="page-head">
        <h2>Settings</h2>
      </header>

      <section className="mt-7">
        <div
          className="mb-3 flex items-baseline justify-between gap-3 pb-2"
          style={{ borderBottom: '1px solid var(--rule)' }}
        >
          <h3 className={sectionTitleClass}>オブジェクトストレージ接続先の管理</h3>
          <button className="ghost" onClick={() => dispatch({ type: 'openAdd' })}>
            <span aria-hidden>+</span> 追加
          </button>
        </div>

        {loading && (
          <p className="text-[13px] text-ink-7">読み込み中…</p>
        )}
        {error && <p className="error">{error}</p>}

        {!loading && connections.length === 0 && (
          <div className="empty-state">
            <h3>まだ接続がありません</h3>
            <p>
              追加した接続は <code className="font-mono text-[0.92em]">/storage/&lt;id&gt;/</code> でアクセスできます。<br />
              endpoint / region / アクセスキーをまとめて登録します。
            </p>
            <button className="empty-state__cta" onClick={() => dispatch({ type: 'openAdd' })}>
              最初の接続を追加
            </button>
          </div>
        )}

        {connections.length > 0 && (
          <ul className="m-0 list-none p-0">
            {connections.map(conn => (
              <li
                key={conn.id}
                className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 p-4"
                style={{ borderBottom: '1px solid var(--rule)' }}
              >
                <div className="min-w-0 flex-1">
                  <strong className="block text-[15px] font-semibold tracking-[0.005em] text-ink-12">
                    {conn.name}
                  </strong>
                  <div
                    className="mt-1 font-mono text-[12px] text-ink-7"
                    style={{ letterSpacing: '0.01em' }}
                  >
                    {conn.endpoint} <span className="text-ink-3">·</span>{' '}
                    {conn.region} <span className="text-ink-3">·</span>{' '}
                    {conn.accessKeyIdMasked}
                    {conn.forcePathStyle && (
                      <>
                        {' '}<span className="text-ink-3">·</span>{' '}
                        <span className="text-ink-5">path-style</span>
                      </>
                    )}
                    {' '}<span className="text-ink-3">·</span>{' '}
                    <span className="text-ink-5">list-{conn.listObjectsVersion}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Link className="ghost" to={`/storage/${encodeURIComponent(conn.id)}/`}>開く</Link>
                  <button className="ghost" onClick={() => dispatch({ type: 'openEdit', conn })}>編集</button>
                  <button
                    className="ghost conn-row__danger"
                    onClick={() => dispatch({ type: 'openDelete', conn })}
                  >
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <About />

      {adding && (
        <ConnectionForm
          mode={{ kind: 'create', onSubmit: handleCreate }}
          onClose={() => dispatch({ type: 'closeAdd' })}
        />
      )}
      {editing && (
        <ConnectionForm
          mode={{ kind: 'edit', current: editing, onSubmit: handleUpdate(editing.id) }}
          onClose={() => dispatch({ type: 'closeEdit' })}
        />
      )}
      {deleting && (
        <ConnectionDeleteConfirm
          name={deleting.name}
          onConfirm={handleDelete(deleting.id)}
          onCancel={() => dispatch({ type: 'closeDelete' })}
        />
      )}
    </div>
  )
}
