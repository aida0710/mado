import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Connection, ConnectionCreateInput, ConnectionUpdateInput } from '../api/types'
import { ConnectionForm } from '../components/ConnectionForm'
import { ConnectionDeleteConfirm } from '../components/ConnectionDeleteConfirm'
import { useFlags } from '../lib/flagsContext'

const FLAG_LABELS: Record<string, { label: string; description?: string }> = {
  metrics: {
    label: 'メトリクス',
    description: '無効にすると Metrics タブと API が使えなくなります。',
  },
}

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

  if (!flags) return <p className="muted">機能フラグを読み込み中…</p>

  const entries = Object.entries(flags)
  if (entries.length === 0) return null

  return (
    <ul className="connections-list">
      {entries.map(([name, enabled]) => {
        const meta = FLAG_LABELS[name] ?? { label: name }
        return (
          <li key={name} className="conn-row">
            <div>
              <strong>{meta.label}</strong>
              {meta.description && (
                <div className="conn-row__meta">{meta.description}</div>
              )}
            </div>
            <div className="conn-row__actions">
              <label className="flag-toggle">
                <input
                  type="checkbox"
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
    <div className="page">
      <div className="page-head">
        <h2>設定</h2>
      </div>

      <section className="settings-section">
        <h3 className="settings-section__title">機能フラグ</h3>
        <FeatureFlagsSection />
      </section>

      <section className="settings-section">
        <div className="settings-section__head">
          <h3 className="settings-section__title">オブジェクトストレージ接続</h3>
          <button className="ghost" onClick={() => setAdding(true)}>+ 追加</button>
        </div>
        {loading && <p className="muted">読み込み中…</p>}
        {error && <p className="error">{error}</p>}
        {!loading && connections.length === 0 && (
          <div className="empty-state">
            <h3>まだ接続がありません</h3>
            <p className="muted">追加した接続は <code>/storage/&lt;id&gt;/</code> でアクセスできます。</p>
            <button className="empty-state__cta" onClick={() => setAdding(true)}>
              最初の接続を追加
            </button>
          </div>
        )}
        {connections.length > 0 && (
          <ul className="connections-list">
            {connections.map(conn => (
              <li key={conn.id} className="conn-row">
                <div>
                  <strong>{conn.name}</strong>
                  <div className="conn-row__meta">
                    {conn.endpoint} · {conn.region} · {conn.accessKeyIdMasked}
                    {conn.forcePathStyle && ' · path-style'}
                  </div>
                </div>
                <div className="conn-row__actions">
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
