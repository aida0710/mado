import { useCallback, useEffect, useReducer } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api/client'
import { ALL_CAPABILITIES_ON, CAPABILITY_UI } from '../lib/api/types'
import type { Capabilities, Connection } from '../lib/api/types'
import { ConnectionDeleteConfirm } from '../components/ConnectionDeleteConfirm'
import { ImportExportButtons } from '../components/ImportExportButtons'
import { SettingsSectionHeader } from '../components/SettingsSectionHeader'
import { downloadJson, type ImportMode, type ImportSummary } from '../lib/jsonFile'
import { invalidateCapabilitiesCache } from '../lib/useCapabilities'

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
  | { type: 'openDelete'; conn: Connection }
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
      return { ...s, deleting: a.conn }
    case 'closeDelete':
      return { ...s, deleting: null }
  }
}

export default function ConnectionsPage() {
  const [state, dispatch] = useReducer(reducer, initial)
  const { connections, loading, error, deleting } = state

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

  return (
    <div>
      <section>
        <SettingsSectionHeader
          title="オブジェクトストレージ接続先の管理"
          actions={
            <span className="inline-flex flex-wrap items-center gap-2">
              <ImportExportButtons
                what="接続"
                replaceWarning="削除される接続の README・お気に入り・タグ割り当ても、まとめて消えます (connection_id の連鎖削除)。ファイルに載っている接続は作り直さないので、それらは残ります。"
                onExport={handleExport}
                onImport={handleImport}
                onDone={refresh}
              />
              <Link className="ghost" to="/settings/connections/new">
                <span aria-hidden>+</span> 追加
              </Link>
            </span>
          }
        />

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
            <Link className="empty-state__cta" to="/settings/connections/new">
              最初の接続を追加
            </Link>
          </div>
        )}

        {connections.length > 0 && (
          <ul className="m-0 list-none p-0">
            {connections.map(conn => (
              <li
                key={conn.id}
                className={
                  // 狭い画面では縦積み (名前 + メタ → ボタン行)。横並びのままだと
                  // shrink-0 のボタン群が幅を取り、左カラムが潰れて meta が細切れに
                  // 改行される / 行ごとにボタンの折り返し位置が変わって不揃いになる。
                  'flex flex-col gap-3 p-4 ' +
                  'sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-6 sm:gap-y-3'
                }
                style={{ borderBottom: '1px solid var(--rule)' }}
              >
                <div className="min-w-0 sm:flex-1">
                  <strong className="block text-[15px] font-semibold tracking-[0.005em] text-ink-12">
                    {conn.name}
                    {conn.isDefault ? (
                      <span
                        className="ml-2 align-middle text-[9.5px] font-semibold uppercase tracking-[0.18em] text-ink-7"
                        style={{ border: '1px solid var(--rule)', borderRadius: 2, padding: '1px 5px' }}
                        title="Storage タブはこの接続を開きます"
                      >
                        DEFAULT
                      </span>
                    ) : null}
                    {conn.visibility.mode === 'whitelist' ? (
                      <span
                        className="ml-2 align-middle text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-7"
                        style={{ border: '1px solid var(--rule)', borderRadius: 2, padding: '1px 5px' }}
                        title={`${conn.visibility.allowedUsers.length}人を許可`}
                      >
                        WHITELIST · {conn.visibility.allowedUsers.length}
                      </span>
                    ) : null}
                  </strong>
                  {/* endpoint は空白を含まない長い 1 トークン (R2 の
                      https://<32桁hash>.r2.cloudflarestorage.com 等) になりうる。
                      既定の overflow-wrap では折り返せず画面外へはみ出すので
                      wrap-anywhere で語中改行を許可する。 */}
                  <div
                    className="mt-1 font-mono text-[12px] text-ink-7 wrap-anywhere"
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
                  {/* 制限がかかっている接続は一覧から分かるようにする
                      (編集モーダルを開かないと分からないと、事故の原因になる)。 */}
                  {CAPABILITY_UI.some(({ key }) => !conn.capabilities[key]) && (
                    <div className="mt-1 text-[12px] text-ink-7">
                      制限:{' '}
                      {CAPABILITY_UI
                        .filter(({ key }) => !conn.capabilities[key])
                        .map(({ label }) => label)
                        .join(' / ')}
                    </div>
                  )}
                </div>
                {/* 4 ボタンが 360px 幅に収まらないことがあるので折り返しを許可。 */}
                <div className="flex flex-wrap gap-2 sm:shrink-0">
                  {!conn.isDefault && (
                    <button
                      className="ghost"
                      onClick={() => void handleSetDefault(conn.id)}
                      title="Storage タブで開く接続にする"
                    >
                      デフォルトにする
                    </button>
                  )}
                  <Link className="ghost" to={`/storage/${encodeURIComponent(conn.id)}/`}>開く</Link>
                  <Link className="ghost" to={`/settings/connections/${encodeURIComponent(conn.id)}`}>編集</Link>
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
