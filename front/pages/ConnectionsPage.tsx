import { useCallback, useEffect, useReducer, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronUp, Plus } from 'lucide-react'
import { api } from '../lib/api/client'
import { ALL_CAPABILITIES_ON, CAPABILITY_UI } from '../lib/api/types'
import type { Capabilities, Connection } from '../lib/api/types'
import { ConnectionDeleteConfirm } from '../components/ConnectionDeleteConfirm'
import { ImportExportButtons } from '../components/ImportExportButtons'
import { SettingsSectionHeader } from '../components/SettingsSectionHeader'
import { downloadJson, type ImportMode, type ImportSummary } from '../lib/jsonFile'
import { invalidateCapabilitiesCache } from '../lib/useCapabilities'
import { narrowerThan } from '../lib/breakpoints'
import { useMediaQuery } from '../lib/useMediaQuery'

// エクスポート形式。認証情報は空文字で書き出す。
//
// アクセスキー / シークレットキーは暗号化して保存され、API は平文を返さない
// (accessKeyIdMasked しか出てこない)。したがって「秘密を伏せる」というより
// 「そもそも取り出せない」ので、両方とも空にして雛形として出す。
// 取り込む側でファイルに書き足してもらう。
interface ConnectionsExport {
  mado: 'connections'
  version: 2
  connections: Array<{
    name: string
    endpoint: string
    region: string
    accessKeyId: string
    secretAccessKey: string
    forcePathStyle: boolean
    listObjectsVersion: 'v1' | 'v2'
    // 権限も持ち回す。省略されたファイル (v1 初期のエクスポート) は全許可扱い。
    capabilities?: Partial<Capabilities>
    // v2。ホワイトリストを公開接続として復元する fail-open を防ぐ。
    visibility?: {
      mode: 'public' | 'whitelist'
      allowedUserIds: string[]
    }
  }>
}

function sanitizeVisibility(raw: unknown): {
  mode: 'public' | 'whitelist'
  allowedUserIds: string[]
} {
  if (!raw || typeof raw !== 'object') return { mode: 'public', allowedUserIds: [] }
  const value = raw as Record<string, unknown>
  const mode = value.mode === 'whitelist' ? 'whitelist' : 'public'
  const allowedUserIds = Array.isArray(value.allowedUserIds)
    ? [...new Set(value.allowedUserIds.filter((id): id is string => typeof id === 'string'))].sort()
    : []
  return { mode, allowedUserIds }
}

/** インポートしたファイルの capabilities を Capabilities に正規化する。
 *  boolean 以外 / 未知のキーは無視し、欠けているキーは既定 (許可) にする。 */
function sanitizeCapabilities(raw: unknown): Capabilities {
  const out = { ...ALL_CAPABILITIES_ON }
  if (raw && typeof raw === 'object') {
    for (const { key } of CAPABILITY_UI) {
      const v = (raw as Record<string, unknown>)[key]
      if (typeof v === 'boolean') out[key] = v
    }
  }
  // 壊れたファイルで「編集だけ有効」が来ると API が 400 を返すので先に整える。
  if (!out.readmeRead) out.readmeWrite = false
  return out
}

/** 一覧の表の列。primary の列は狭い画面でも行に残し、ほかは行の下に開く詳細へ移す。 */
interface Column {
  key: string
  header: string
  primary: boolean
  className?: string
  render: (connection: Connection) => ReactNode
}

interface State {
  connections: Connection[]
  loading: boolean
  error: string | null
  deleting: Connection | null
}

type Action =
  | { type: 'startLoad' }
  | { type: 'loadOk'; rows: Connection[] }
  | { type: 'loadErr'; error: string }
  | { type: 'openDelete'; connection: Connection }
  | { type: 'closeDelete' }

const initial: State = {
  connections: [],
  loading: true,
  error: null,
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
    case 'openDelete':
      return { ...s, deleting: a.connection }
    case 'closeDelete':
      return { ...s, deleting: null }
  }
}

export default function ConnectionsPage() {
  const [state, dispatch] = useReducer(reducer, initial)
  const { connections, loading, error, deleting } = state
  const isNarrow = useMediaQuery(narrowerThan('md'))
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const toggleRow = (id: string) => setOpenIds(current => {
    const next = new Set(current)
    if (!next.delete(id)) next.add(id)
    return next
  })

  const refresh = useCallback(() => {
    dispatch({ type: 'startLoad' })
    // 権限を読むために接続一覧をセッション内でメモしているので、
    // 接続を触ったらそちらも捨てる (ピン留めカードが古い権限で描かれないように)。
    invalidateCapabilitiesCache()
    api.listConnections()
      .then(rows => dispatch({ type: 'loadOk', rows }))
      .catch((e: Error) => dispatch({ type: 'loadErr', error: e.message }))
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const handleDelete = (id: string) => async () => {
    await api.deleteConnection(id)
    dispatch({ type: 'closeDelete' })
    refresh()
  }
  const handleSetDefault = async (id: string) => {
    try {
      await api.setDefaultConnection(id)
      refresh()
    } catch (e) {
      dispatch({ type: 'loadErr', error: (e as Error).message })
    }
  }

  const handleExport = () => {
    const body: ConnectionsExport = {
      mado: 'connections',
      version: 2,
      connections: connections.map(c => ({
        name: c.name,
        endpoint: c.endpoint,
        region: c.region,
        // 平文を取り出せないので雛形として空で出す (上のコメント参照)。
        accessKeyId: '',
        secretAccessKey: '',
        forcePathStyle: c.forcePathStyle,
        listObjectsVersion: c.listObjectsVersion,
        capabilities: c.capabilities,
        visibility: {
          mode: c.visibility.mode,
          allowedUserIds: c.visibility.allowedUsers.map(user => user.id).sort(),
        },
      })),
    }
    downloadJson('mado-connections.json', body)
  }

  // 同名の接続はスキップする。同じ名前が並ぶと Storage の CONN メニューで
  // 見分けがつかなくなるため。
  const handleImport = async (data: unknown, mode: ImportMode): Promise<ImportSummary> => {
    const d = data as { mado?: unknown; connections?: unknown } | null
    if (d?.mado !== 'connections' || !Array.isArray(d.connections)) {
      throw new Error('mado の接続のエクスポートファイルではありません。')
    }
    const existing = new Set(connections.map(c => c.name))
    const summary: ImportSummary = { added: 0, skipped: 0, removed: 0, failed: [] }

    // 置き換え = 同期。ファイルに無い接続を消す。ファイルに載っている接続は
    // 作り直さないので、その README / お気に入り / タグ割り当ては
    // そのまま残る。消える接続についてはそれらも CASCADE で一緒に消える。
    if (mode === 'replace') {
      const wanted = new Set(
        (d.connections as unknown[])
          .map(c => (c as Record<string, unknown>)?.name)
          .filter((n): n is string => typeof n === 'string'),
      )
      for (const c of connections) {
        if (wanted.has(c.name)) continue
        try {
          await api.deleteConnection(c.id)
          summary.removed = (summary.removed ?? 0) + 1
          existing.delete(c.name)
        } catch (e) {
          summary.failed.push(`${c.name}: ${(e as Error).message}`)
        }
      }
    }
    for (const raw of d.connections as unknown[]) {
      const c = raw as Record<string, unknown>
      if (typeof c?.name !== 'string' || typeof c?.endpoint !== 'string' || typeof c?.region !== 'string') {
        summary.failed.push('name / endpoint / region が文字列でない項目があります')
        continue
      }
      if (existing.has(c.name)) { summary.skipped++; continue }
      // 空のまま取り込むと API の min(1) で弾かれるので、先に理由を出す。
      if (!c.accessKeyId || !c.secretAccessKey) {
        summary.failed.push(`${c.name}: アクセスキー / シークレットキーが空です`)
        continue
      }
      try {
        await api.createConnection({
          name: c.name,
          endpoint: c.endpoint,
          region: c.region,
          accessKeyId: String(c.accessKeyId),
          secretAccessKey: String(c.secretAccessKey),
          forcePathStyle: c.forcePathStyle !== false,
          listObjectsVersion: c.listObjectsVersion === 'v1' ? 'v1' : 'v2',
          capabilities: sanitizeCapabilities(c.capabilities),
          visibility: sanitizeVisibility(c.visibility),
        })
        existing.add(c.name)
        summary.added++
      } catch (e) {
        summary.failed.push(`${c.name}: ${(e as Error).message}`)
      }
    }
    return summary
  }

  const restrictions = (connection: Connection) =>
    CAPABILITY_UI.filter(({ key }) => !connection.capabilities[key]).map(({ label }) => label)

  const columns: Column[] = [
    {
      key: 'name',
      header: '名前',
      primary: true,
      render: connection => (
        <>
          <span className="connection-name">
            <strong>{connection.name}</strong>
            {connection.isDefault && (
              <span className="status-badge connection-default" title="Storage タブはこの接続を開きます">
                DEFAULT
              </span>
            )}
            {connection.visibility.mode === 'whitelist' && (
              <span
                className="status-badge status-queued"
                title={`${connection.visibility.allowedUsers.length}人を許可`}
              >
                WHITELIST · {connection.visibility.allowedUsers.length}
              </span>
            )}
          </span>
          {/* 制限がかかっている接続は一覧から分かるようにする
              (編集画面を開かないと分からないと、事故の原因になる)。 */}
          {restrictions(connection).length > 0 && (
            <span className="connection-restrictions muted">
              制限: {restrictions(connection).join(' / ')}
            </span>
          )}
        </>
      ),
    },
    {
      key: 'endpoint',
      header: 'エンドポイント・リージョン',
      primary: false,
      className: 'mono',
      render: connection => (
        <>
          {/* endpoint は空白を含まない長い 1 トークン (R2 の
              https://<32桁hash>.r2.cloudflarestorage.com 等) になりうるので、語中で折り返す。 */}
          <span className="connection-endpoint break-word">{connection.endpoint}</span>
          <span className="connection-region muted">{connection.region}</span>
        </>
      ),
    },
    {
      key: 'other',
      header: 'その他',
      primary: false,
      className: 'mono muted',
      // 項目の途中 (list-v2 のハイフンなど) では折り返さず、項目の間で折り返す。
      render: connection => [
        connection.accessKeyIdMasked,
        connection.forcePathStyle ? 'path-style' : null,
        `list-${connection.listObjectsVersion}`,
      ].filter(item => item !== null).map((item, index) => (
        <span key={item}>
          {index > 0 && ' · '}
          <span className="nowrap">{item}</span>
        </span>
      )),
    },
    {
      key: 'actions',
      header: '操作',
      primary: false,
      className: 'row-actions',
      render: connection => (
        <span className="row-actions__buttons">
          {!connection.isDefault && (
            <button
              type="button"
              className="button small"
              onClick={() => void handleSetDefault(connection.id)}
              title="Storage タブで開く接続にする"
            >
              デフォルトにする
            </button>
          )}
          <Link className="button small" to={`/storage/${encodeURIComponent(connection.id)}/`}>開く</Link>
          <Link className="button small" to={`/settings/connections/${encodeURIComponent(connection.id)}`}>編集</Link>
          <button
            type="button"
            className="button small danger"
            onClick={() => dispatch({ type: 'openDelete', connection })}
          >
            削除
          </button>
        </span>
      ),
    },
  ]
  // 狭い画面では名前だけを行に残し、ほかは行の下に開く (Mado Model Tracking の表と同じ考え方)。
  const rowColumns = isNarrow ? columns.filter(column => column.primary) : columns
  const detailColumns = isNarrow ? columns.filter(column => !column.primary) : []

  return (
    <section>
      <SettingsSectionHeader
        title="オブジェクトストレージ接続先の管理"
        actions={
          <>
            <ImportExportButtons
              what="接続"
              replaceWarning="削除される接続の README・お気に入り・タグ割り当ても、まとめて消えます (connection_id の連鎖削除)。ファイルに載っている接続は作り直さないので、それらは残ります。"
              onExport={handleExport}
              onImport={handleImport}
              onDone={refresh}
            />
            <Link className="button primary small" to="/settings/connections/new">
              <Plus size={14} aria-hidden="true" />
              追加
            </Link>
          </>
        }
      />

      {loading && <p className="state-message">読み込み中…</p>}
      {error && <p className="notice error">{error}</p>}

      {!loading && connections.length === 0 && (
        <div className="empty-state">
          <h3>まだ接続がありません</h3>
          <p>
            追加した接続は <code>/storage/&lt;id&gt;/</code> でアクセスできます。<br />
            endpoint / region / アクセスキーをまとめて登録します。
          </p>
          <Link className="button primary" to="/settings/connections/new">
            <Plus size={15} aria-hidden="true" />
            最初の接続を追加
          </Link>
        </div>
      )}

      {connections.length > 0 && (
        <div className="table-scroll">
          <table className="responsive-table connections-table">
            <thead>
              <tr>
                {rowColumns.map(column => (
                  <th key={column.key} scope="col">
                    {column.key === 'actions' ? <span className="sr-only">{column.header}</span> : column.header}
                  </th>
                ))}
                {isNarrow && (
                  <th scope="col" className="responsive-table-toggle">
                    <span className="sr-only">詳細を表示</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {connections.map(connection => {
                const isOpen = isNarrow && openIds.has(connection.id)
                const detailId = `connection-details-${connection.id}`
                return [
                  <tr key={connection.id}>
                    {rowColumns.map(column => (
                      <td key={column.key} className={column.className}>{column.render(connection)}</td>
                    ))}
                    {isNarrow && (
                      <td className="responsive-table-toggle">
                        <button
                          type="button"
                          className="icon-button"
                          aria-expanded={isOpen}
                          aria-controls={detailId}
                          aria-label={isOpen ? '詳細を閉じる' : '詳細を表示'}
                          title={isOpen ? '詳細を閉じる' : '詳細を表示'}
                          onClick={() => toggleRow(connection.id)}
                        >
                          {isOpen ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
                        </button>
                      </td>
                    )}
                  </tr>,
                  isOpen && (
                    <tr key={`${connection.id}-details`} id={detailId} className="responsive-table-details">
                      <td colSpan={rowColumns.length + 1}>
                        <dl>
                          {detailColumns.map(column => (
                            <div key={column.key}>
                              {/* 操作のボタンは見出しを付けずに一行を使って並べる (名前は読み上げにだけ残す)。 */}
                              <dt className={column.key === 'actions' ? 'sr-only' : undefined}>{column.header}</dt>
                              <dd className={column.className}>{column.render(connection)}</dd>
                            </div>
                          ))}
                        </dl>
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}

      {deleting && (
        <ConnectionDeleteConfirm
          name={deleting.name}
          onConfirm={handleDelete(deleting.id)}
          onCancel={() => dispatch({ type: 'closeDelete' })}
        />
      )}
    </section>
  )
}
