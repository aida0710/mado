import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import type { Connection, ConnectionCreateInput, ConnectionUpdateInput } from '../lib/api/types'
import { ConnectionForm } from '../components/ConnectionForm'
import { ConnectionDeleteConfirm } from '../components/ConnectionDeleteConfirm'
import { useFlags } from '../lib/flagsContext'

const FLAG_LABELS: Record<string, { label: string; description?: string }> = {
  metrics: {
    label: 'Metrics',
    description: '無効にすると Metrics タブと API が使えなくなります。',
  },
}

const sectionTitleClass =
  'mb-2 mt-0 text-sm font-semibold uppercase tracking-[0.02em] text-ink-7'
const rowClass =
  'flex items-center justify-between gap-4 rounded-3 border border-ink-2 ' +
  'bg-paper p-3 transition-colors hover:border-ink-3'
const rowMetaClass = 'mt-1 font-mono text-xs text-ink-7'
const rowActionsClass = 'flex gap-2'

function FeatureFlagsSection() {
  const { flags, refresh } = useFlags()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = async (name: string, next: boolean) => {
    setBusy(name)
    setError(null)
    try {
      await api.setFlag(name, next)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!flags) return <p className="text-ink-7">機能フラグを読み込み中…</p>

  const entries = Object.entries(flags)
  if (entries.length === 0) return null

  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {entries.map(([name, enabled]) => {
        const meta = FLAG_LABELS[name] ?? { label: name }
        return (
          <li key={name} className={rowClass}>
            <div>
              <strong>{meta.label}</strong>
              {meta.description && (
                <div className={rowMetaClass}>{meta.description}</div>
              )}
            </div>
            <div className={rowActionsClass}>
              <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="cursor-pointer"
                  checked={enabled}
                  disabled={busy === name}
                  onChange={e => toggle(name, e.target.checked)}
                />
                <span>{enabled ? '有効' : '無効'}</span>
              </label>
            </div>
          </li>
        )
      })}
      {error && <li><p className="error">{error}</p></li>}
    </ul>
  )
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Connection | null>(null)
  const [deleting, setDeleting] = useState<Connection | null>(null)

  const refresh = useCallback(() => {
    setLoading(true)
    setError(null)
    api.listConnections()
      .then(rows => setConnections(rows))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const handleCreate = async (input: ConnectionCreateInput) => {
    await api.createConnection(input)
    refresh()
    setAdding(false)
  }
  const handleUpdate = (id: string) => async (input: ConnectionUpdateInput) => {
    await api.updateConnection(id, input)
    refresh()
    setEditing(null)
  }
  const handleDelete = (id: string) => async () => {
    await api.deleteConnection(id)
    refresh()
    setDeleting(null)
  }

  return (
    <div>
      <div className="page-head">
        <h2>設定</h2>
      </div>

      <section className="my-6 first-of-type:mt-2">
        <h3 className={sectionTitleClass}>機能フラグ</h3>
        <FeatureFlagsSection />
      </section>

      <section className="my-6">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className={sectionTitleClass}>オブジェクトストレージ接続</h3>
          <button className="ghost" onClick={() => setAdding(true)}>+ 追加</button>
        </div>
        {loading && <p className="text-ink-7">読み込み中…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && connections.length === 0 && (
          <div className="empty-state">
            <h3>まだ接続がありません</h3>
            <p className="text-ink-7">追加した接続は <code>/storage/&lt;id&gt;/</code> でアクセスできます。</p>
            <button className="empty-state__cta" onClick={() => setAdding(true)}>
              最初の接続を追加
            </button>
          </div>
        )}
        {connections.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {connections.map(conn => (
              <li key={conn.id} className={rowClass}>
                <div>
                  <strong>{conn.name}</strong>
                  <div className={rowMetaClass}>
                    {conn.endpoint} · {conn.region} · {conn.accessKeyIdMasked}
                    {conn.forcePathStyle && ' · path-style'}
                  </div>
                </div>
                <div className={rowActionsClass}>
                  <Link className="ghost" to={`/storage/${conn.id}/`}>開く</Link>
                  <button className="ghost" onClick={() => setEditing(conn)}>編集</button>
                  <button
                    className="ghost conn-row__danger"
                    onClick={() => setDeleting(conn)}
                  >
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {adding && (
        <ConnectionForm
          mode={{ kind: 'create', onSubmit: handleCreate }}
          onClose={() => setAdding(false)}
        />
      )}
      {editing && (
        <ConnectionForm
          mode={{ kind: 'edit', current: editing, onSubmit: handleUpdate(editing.id) }}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <ConnectionDeleteConfirm
          name={deleting.name}
          onConfirm={handleDelete(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
