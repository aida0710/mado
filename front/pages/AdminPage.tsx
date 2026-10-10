import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { ChevronDown, ChevronUp, Copy, RefreshCw } from 'lucide-react'
import { DeleteConfirmDialog } from '../components/DeleteConfirmDialog'
import { fetchApi } from '../lib/api/http'
import { useAuth } from '../lib/auth-context'
import { narrowerThan } from '../lib/breakpoints'
import { useMediaQuery } from '../lib/useMediaQuery'

interface UserRow {
  id: string
  username: string | null
  email: string | null
  displayName: string
  status: 'active' | 'disabled'
  roles: string[]
  authMethods: Array<'local' | 'sso'>
}

interface ServiceAccountRow {
  id: string
  name: string
  description: string
  status: 'active' | 'disabled'
}

interface AuditEventRow {
  id: number
  occurred_at: string
  actor_type: string
  actor_label: string
  action: string
  resource_type: string | null
  resource_id: string | null
  outcome: 'pending' | 'success' | 'denied' | 'failure'
  details?: {
    target?: { displayName?: string | null; username?: string | null }
    changes?: Array<{ field: string; label?: string; before: unknown; after: unknown }>
    [key: string]: unknown
  }
}

interface AuditPage {
  events: AuditEventRow[]
  nextBeforeId: number | null
}

const ACTION_LABELS: Record<string, string> = {
  'auth.password.change': 'パスワード変更',
  'auth.profile.update': 'アカウント設定変更',
  'auth.bootstrap_admin': '初期管理者を作成',
  'auth.oidc.session_revoke': 'SSOセッションを失効',
  'auth.oidc.sync': 'SSOアカウント情報を同期',
  'connection.create': '接続を追加',
  'connection.update': '接続を変更',
  'connection.delete': '接続を削除',
  'connection.default.set': 'デフォルト接続を変更',
  'note.update': '共有ノートを保存',
  'note.read': '共有ノートを閲覧',
  'storage.readme.update': 'READMEを保存',
  'storage.readme.read': 'READMEを閲覧',
  'storage.scan.start': '走査を開始',
  'storage.tag.assign': 'タグを付与',
  'storage.tag.remove': 'タグを解除',
  'storage.favorite.add': 'お気に入りへ追加',
  'storage.favorite.remove': 'お気に入りから削除',
  'storage.download.raw': 'ファイルをダウンロード',
  'storage.download.tar': 'アーカイブをダウンロード',
  'storage.download.tar-entry': 'アーカイブ内をダウンロード',
  'storage.preview.text': 'テキストを閲覧',
  'storage.preview.image': '画像を閲覧',
  'tag.create': 'タグを作成',
  'tag.update': 'タグを変更',
  'tag.delete': 'タグを削除',
  'setting.update': '設定を変更',
  'pricing.refresh': '料金を更新',
  'job.cancel': 'ジョブを中断',
  'lineage.read': 'DataLineageを閲覧',
  'lineage.dataset.update': 'データセット情報を変更',
  'lineage.dataset.register': 'データセットを登録',
  'lineage.location.register': '保存場所を登録',
  'lineage.run.register': '処理履歴を登録',
  'lineage.ingest': 'OpenLineageイベントを反映',
  'service_account.create': 'Service Accountを作成',
  'service_account.update': 'Service Accountを変更',
  'service_account.key.issue': 'API keyを発行',
  'service_account.key.revoke': 'API keyを失効',
  'user.create': 'ユーザーを作成',
  'user.update': 'ユーザーを変更',
  'user.roles.update': 'ユーザー権限を変更',
  'user.password.reset': 'パスワードを再発行',
  'user.delete': 'ユーザーを削除',
  'user.manage': 'ユーザー操作',
  'service_account.manage': 'Service Account操作',
}

const OUTCOME_LABELS: Record<AuditEventRow['outcome'], string> = {
  pending: 'PENDING',
  success: 'OK',
  denied: 'DENIED',
  failure: 'ERROR',
}

const ROLE_OPTIONS = [
  { id: 'viewer', label: 'Viewer — 閲覧のみ', help: 'StorageとDataLineageを閲覧できます。' },
  { id: 'curator', label: 'Curator — 内容編集', help: '閲覧に加え、README・ノート・タグなどを編集できます。' },
  { id: 'operator', label: 'Operator — ジョブ実行', help: '閲覧に加え、走査・料金更新・ジョブ中断を実行できます。' },
  { id: 'admin', label: 'Admin — すべて管理', help: '接続・設定・ユーザー・API key・監査ログを含む全操作ができます。' },
] as const

type RoleId = (typeof ROLE_OPTIONS)[number]['id']

// Service Account keyの用途。Madoのデータへは読み取りのscopeだけを開く。
const KEY_SCOPE_OPTIONS = [
  { scope: 'lineage:write', label: 'OpenLineage送信（lineage:write）', help: '許可したNamespaceへだけLineageを書き込めます。' },
  { scope: 'metrics:read', label: 'Prometheus収集（metrics:read）', help: '/api/mado/metrics/capacity（容量メトリクス）から、利用者を限定した接続も含めて全接続のバケット名・容量を読み取れます。書き込みはできません。' },
] as const

type KeyScope = (typeof KEY_SCOPE_OPTIONS)[number]['scope']

interface UsersResponse {
  users: UserRow[]
  ssoRoleMapping?: Record<string, string>
}

function normalizeSsoRoleMapping(mapping: Record<string, string> | undefined) {
  const roleOrder = new Map(ROLE_OPTIONS.map((option, index) => [option.id, index]))
  return Object.entries(mapping ?? {})
    .filter((entry): entry is [string, RoleId] => roleOrder.has(entry[1] as RoleId))
    .map(([group, role]) => ({ group, role }))
    .sort((a, b) => (roleOrder.get(a.role) ?? 0) - (roleOrder.get(b.role) ?? 0)
      || a.group.localeCompare(b.group))
}

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length ? value.map(formatAuditValue).join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetchApi(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? response.statusText)
  }
  return response.json() as Promise<T>
}

const OUTCOME_BADGES: Record<AuditEventRow['outcome'], string> = {
  pending: 'status-attention',
  success: 'status-finished',
  denied: 'status-failed',
  failure: 'status-failed',
}

const STATUS_BADGES: Record<'active' | 'disabled', string> = {
  active: 'status-finished',
  disabled: 'status-queued',
}

// 行のクリックで詳細を開く。行の中のボタンや入力欄は、それぞれの操作だけをする。
const INTERACTIVE_SELECTOR = 'a, button, input, select, textarea, label, summary'

function isFromControl(event: MouseEvent<HTMLElement>) {
  const control = (event.target as Element).closest(INTERACTIVE_SELECTOR)
  return control !== null && event.currentTarget.contains(control)
}

/** 開いている行の key の集合と、その開け閉め。 */
function useOpenRows<K>() {
  const [open, setOpen] = useState<ReadonlySet<K>>(() => new Set())
  const toggle = useCallback((key: K) => setOpen(current => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  }), [])
  return [open, toggle] as const
}

/** 表の右端の、行の下に詳細を開くボタン。 */
function RowToggle({ open, controls, onToggle }: { open: boolean; controls: string; onToggle: () => void }) {
  const label = open ? '詳細を閉じる' : '詳細を表示'
  return (
    <button
      type="button"
      className="icon-button"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
    </button>
  )
}

/** 一度だけ表示する秘密の値 (一時パスワード・API key)。閉じたら二度と出ない。 */
function SecretNotice({ secret, note, onClose }: {
  secret: { label: string; value: string }
  note: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // 一覧の下の行やフォームから発行すると、ここは画面の外にあることが多い。見えるところまで送る。
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [secret.value])
  return (
    <div ref={ref} className="secret-notice" role="status">
      <strong>{secret.label} — {note}</strong>
      <code>{secret.value}</code>
      <span className="secret-notice__actions">
        <button type="button" className="button small" onClick={() => void navigator.clipboard.writeText(secret.value)}>
          <Copy size={14} aria-hidden="true" />
          コピー
        </button>
        <button type="button" className="button small" onClick={onClose}>閉じる</button>
      </span>
    </div>
  )
}

function StatusBadge({ status }: { status: 'active' | 'disabled' }) {
  return <span className={`status-badge ${STATUS_BADGES[status]}`}>{status}</span>
}

function UsersPage() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<UserRow[]>([])
  const [ssoRoleMappings, setSsoRoleMappings] = useState<Array<{ group: string; role: RoleId }>>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [role, setRole] = useState<RoleId>('viewer')
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [deleting, setDeleting] = useState<UserRow | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | UserRow['status']>('')
  const [openIds, toggleRow] = useOpenRows<string>()
  // 狭い画面ではメール・権限・認証の列を省く。どれも行を開いた編集欄に出ている。
  const isNarrow = useMediaQuery(narrowerThan('md'))

  const reload = useCallback(async () => {
    setError(null)
    try {
      const body = await jsonRequest<UsersResponse>('/api/internal/users')
      setUsers(body.users)
      setSsoRoleMappings(normalizeSsoRoleMapping(body.ssoRoleMapping))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ユーザーを取得できませんでした')
    }
  }, [])

  useEffect(() => {
    let current = true
    jsonRequest<UsersResponse>('/api/internal/users')
      .then(body => {
        if (!current) return
        setUsers(body.users)
        setSsoRoleMappings(normalizeSsoRoleMapping(body.ssoRoleMapping))
      })
      .catch(cause => {
        if (current) setError(cause instanceof Error ? cause.message : 'ユーザーを取得できませんでした')
      })
    return () => { current = false }
  }, [])

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError(null)
    try {
      await jsonRequest('/api/internal/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.get('username'), email: form.get('email') || null,
          displayName: form.get('displayName'), password: form.get('password'), roles: [form.get('role')],
        }),
      })
      formElement.reset()
      setRole('viewer')
      setNotice('Local Userを作成しました。初回ログイン時にパスワード変更が必要です。')
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '作成できませんでした')
    }
  }

  const updateUser = async (event: FormEvent<HTMLFormElement>, user: UserRow) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    setNotice(null)
    try {
      await jsonRequest(`/api/internal/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: form.get('displayName'),
          username: form.get('username'),
          status: form.get('status'),
        }),
      })
      // SSO連携済みUserのRoleはAuthentikを正本としてlogin時に同期する。
      // disabledなform controlはFormDataに含まれないため、API呼び出し自体も明示的に省く。
      if (!user.authMethods.includes('sso')) {
        const nextRole = String(form.get('role'))
        if (user.roles.length !== 1 || user.roles[0] !== nextRole) {
          await jsonRequest(`/api/internal/users/${encodeURIComponent(user.id)}/roles`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roles: [nextRole] }),
          })
        }
      }
      setNotice(`${String(form.get('displayName'))}を更新しました。`)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新できませんでした')
    }
  }

  const resetPassword = async (user: UserRow) => {
    setError(null)
    setNotice(null)
    try {
      const body = await jsonRequest<{ temporaryPassword: string }>(`/api/internal/users/${encodeURIComponent(user.id)}/reset-password`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      setSecret({ label: `${user.displayName}の一時パスワード`, value: body.temporaryPassword })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'パスワードを再発行できませんでした')
    }
  }

  // 失敗したときは確認のダイアログに理由を出し、閉じずに残す。
  const deleteUser = async (user: UserRow) => {
    setError(null)
    setNotice(null)
    await jsonRequest(`/api/internal/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' })
    setDeleting(null)
    setNotice(`${user.displayName}を削除しました。`)
    await reload()
  }

  const needle = query.trim().toLowerCase()
  const visibleUsers = users.filter(user =>
    (!statusFilter || user.status === statusFilter)
    && (!needle || [user.displayName, user.username, user.email]
      .some(value => value?.toLowerCase().includes(needle))))
  const columnCount = isNarrow ? 3 : 6

  return (
    <section className="admin-users">
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      {secret && <SecretNotice secret={secret} note="今だけ表示されます" onClose={() => setSecret(null)} />}
      {users.length > 0 && (
        <>
          <div className="admin-toolbar" role="search">
            <input
              type="search"
              aria-label="ユーザーを検索"
              placeholder="表示名・ユーザーID・メールアドレス"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            <select
              aria-label="状態で絞り込む"
              value={statusFilter}
              onChange={event => setStatusFilter(event.target.value as '' | UserRow['status'])}
            >
              <option value="">すべての状態</option>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          {visibleUsers.length === 0 ? (
            <p className="state-message">条件に合うユーザーはいません。</p>
          ) : (
            <div className="table-scroll">
              <table className="responsive-table admin-users-table">
                <thead>
                  <tr>
                    <th scope="col">表示名</th>
                    {!isNarrow && <th scope="col">メールアドレス</th>}
                    {!isNarrow && <th scope="col">権限</th>}
                    {!isNarrow && <th scope="col">認証</th>}
                    <th scope="col">状態</th>
                    <th scope="col" className="responsive-table-toggle"><span className="sr-only">詳細を表示</span></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map(user => {
                    const isOpen = openIds.has(user.id)
                    const detailId = `admin-user-${user.id}`
                    const sso = user.authMethods.includes('sso')
                    return [
                      <tr
                        key={user.id}
                        className={isOpen ? 'clickable-row selected' : 'clickable-row'}
                        onClick={event => { if (!isFromControl(event)) toggleRow(user.id) }}
                      >
                        <td>
                          <span className="user-name">
                            <strong>{user.displayName}</strong>
                            <span className="muted mono">{user.username ?? 'ユーザーID未設定'}</span>
                          </span>
                        </td>
                        {!isNarrow && <td className="break-word">{user.email ?? '—'}</td>}
                        {!isNarrow && <td>{user.roles.join(', ') || '—'}</td>}
                        {!isNarrow && <td>{user.authMethods.join(' + ') || '未設定'}</td>}
                        <td><StatusBadge status={user.status} /></td>
                        <td className="responsive-table-toggle">
                          <RowToggle open={isOpen} controls={detailId} onToggle={() => toggleRow(user.id)} />
                        </td>
                      </tr>,
                      isOpen && (
                        <tr key={`${user.id}-details`} id={detailId} className="responsive-table-details">
                          <td colSpan={columnCount}>
                            <form
                              className="admin-user-form"
                              aria-label={`${user.displayName}を編集`}
                              onSubmit={event => void updateUser(event, user)}
                            >
                              <label className="field">
                                <span>表示名</span>
                                <input name="displayName" defaultValue={user.displayName} maxLength={128} required />
                              </label>
                              <label className="field">
                                <span>ユーザーID（ログインID）</span>
                                <input name="username" defaultValue={user.username ?? ''} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" required />
                              </label>
                              {user.email && (
                                <div className="field readonly-field admin-user-form__wide">
                                  <span>メールアドレス</span>
                                  <strong className="mono">{user.email}</strong>
                                  <small className="muted">
                                    {sso ? 'SSO側を正本とし、Madoからは変更できません。' : '認証識別子のため、Madoからは変更できません。'}
                                  </small>
                                </div>
                              )}
                              <label className="field">
                                <span>権限</span>
                                <select
                                  name="role"
                                  defaultValue={user.roles[0] ?? 'viewer'}
                                  disabled={sso}
                                  aria-describedby={sso ? `sso-role-help-${user.id}` : undefined}
                                >
                                  {ROLE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                                </select>
                                {sso && (
                                  <small id={`sso-role-help-${user.id}`} className="muted">
                                    SSO側で管理されるため、Madoからは変更できません。
                                  </small>
                                )}
                              </label>
                              <label className="field">
                                <span>状態</span>
                                <select name="status" defaultValue={user.status}>
                                  <option value="active">Active</option>
                                  <option value="disabled">Disabled</option>
                                </select>
                              </label>
                              <dl className="admin-user-meta admin-user-form__wide">
                                <div><dt>内部ID</dt><dd className="mono">{user.id}</dd></div>
                                <div><dt>認証</dt><dd>{user.authMethods.join(' + ') || '未設定'}</dd></div>
                              </dl>
                              <div className="admin-user-form__actions admin-user-form__wide">
                                <button type="submit" className="button primary">保存</button>
                                {!(sso && !user.authMethods.includes('local')) && (
                                  <button type="button" className="button" onClick={() => void resetPassword(user)}>パスワードを再発行</button>
                                )}
                                {user.id !== currentUser?.id && (
                                  <button type="button" className="button danger" onClick={() => setDeleting(user)}>削除</button>
                                )}
                              </div>
                            </form>
                          </td>
                        </tr>
                      ),
                    ]
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <section className="admin-section">
        <form className="admin-create-form" onSubmit={createUser} aria-labelledby="admin-create-user-title">
          <div className="section-heading"><h2 id="admin-create-user-title">ユーザーを追加</h2></div>
          <div className="admin-form-grid">
            <label className="field"><span>表示名</span><input name="displayName" placeholder="例: Mado Curator" required /></label>
            <label className="field"><span>ユーザーID（ログインID）</span><input name="username" placeholder="例: curator" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" required /></label>
            <label className="field"><span>メールアドレス（任意）</span><input name="email" type="email" placeholder="email@example.jp" /></label>
            <label className="field"><span>初回パスワード（12文字以上）</span><input name="password" type="password" minLength={12} autoComplete="new-password" required /></label>
            <label className="field admin-form-grid__wide">
              <span>権限</span>
              <select name="role" value={role} onChange={event => setRole(event.target.value as RoleId)}>
                {ROLE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              <small className="muted">{ROLE_OPTIONS.find(option => option.id === role)?.help}</small>
            </label>
          </div>
          <button type="submit" className="button primary">作成</button>
        </form>
        <blockquote className="sso-guidance">
          <p>SSOの場合、以下のAuthentikグループがMadoの権限と対応しています。権限はログイン時に同期されます。</p>
          <ul>
            {ssoRoleMappings.map(({ group, role }) => (
              <li key={group}>
                <code>{group}</code>
                <span aria-hidden="true">→</span>
                <strong>{ROLE_OPTIONS.find(option => option.id === role)?.label}</strong>
              </li>
            ))}
            {ssoRoleMappings.length === 0 && <li className="sso-guidance__empty">SSO権限マッピングは設定されていません。</li>}
          </ul>
        </blockquote>
      </section>

      {deleting && (
        <DeleteConfirmDialog
          titleId="admin-user-delete-title"
          title="ユーザーを削除"
          onConfirm={() => deleteUser(deleting)}
          onCancel={() => setDeleting(null)}
        >
          {deleting.displayName}を削除しますか？この操作は取り消せません。
        </DeleteConfirmDialog>
      )}
    </section>
  )
}

function ServiceAccountsPage() {
  const [accounts, setAccounts] = useState<ServiceAccountRow[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyScope, setKeyScope] = useState<KeyScope>('lineage:write')

  const reload = useCallback(async () => {
    setError(null)
    try {
      const body = await jsonRequest<{ accounts: ServiceAccountRow[] }>('/api/internal/service-accounts')
      setAccounts(body.accounts)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Service Accountを取得できませんでした')
    }
  }, [])

  useEffect(() => {
    let current = true
    jsonRequest<{ accounts: ServiceAccountRow[] }>('/api/internal/service-accounts')
      .then(body => { if (current) setAccounts(body.accounts) })
      .catch(cause => {
        if (current) setError(cause instanceof Error ? cause.message : 'Service Accountを取得できませんでした')
      })
    return () => { current = false }
  }, [])

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setError(null)
    try {
      await jsonRequest('/api/internal/service-accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.get('name'), description: form.get('description') }),
      })
      formElement.reset()
      setNotice('Service Accountを作成しました。')
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '作成できませんでした')
    }
  }

  const issueKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const accountId = String(form.get('accountId') ?? '')
    // namespaceはOpenLineageの書き込み先を絞るもので、読み取り用keyには送らない。
    const namespaces = keyScope === 'lineage:write'
      ? String(form.get('namespaces') ?? '').split(',').map(value => value.trim()).filter(Boolean)
      : []
    setError(null)
    try {
      const body = await jsonRequest<{ key: { name: string; token: string } }>(
        `/api/internal/service-accounts/${encodeURIComponent(accountId)}/keys`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: form.get('name'), scopes: [keyScope], namespaces }),
        },
      )
      setSecret({ label: body.key.name, value: body.key.token })
      formElement.reset()
      setNotice(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'keyを発行できませんでした')
    }
  }

  return (
    <section className="admin-accounts">
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      {secret && <SecretNotice secret={secret} note="このkeyは今だけ表示されます" onClose={() => setSecret(null)} />}
      {accounts.length > 0 && (
        <div className="table-scroll">
          <table className="admin-accounts-table">
            <thead>
              <tr>
                <th scope="col">名前</th>
                <th scope="col">用途</th>
                <th scope="col">状態</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(account => (
                <tr key={account.id}>
                  <td className="break-word"><strong>{account.name}</strong></td>
                  <td className={account.description ? undefined : 'muted'}>{account.description || '説明なし'}</td>
                  <td><StatusBadge status={account.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="admin-forms">
        <section className="admin-section">
          <form onSubmit={createAccount} aria-labelledby="admin-create-account-title">
            <div className="section-heading"><h2 id="admin-create-account-title">Service Accountを追加</h2></div>
            <label className="field"><span>Service Account名</span><input name="name" placeholder="例: nemo-curator-production" required /></label>
            <label className="field"><span>用途（任意）</span><input name="description" placeholder="例: 音声前処理の本番Pipeline" /></label>
            <button type="submit" className="button primary">作成</button>
          </form>
        </section>
        <section className="admin-section">
          <form onSubmit={issueKey} aria-labelledby="admin-issue-key-title">
            <div className="section-heading"><h2 id="admin-issue-key-title">APIキーを発行</h2></div>
            <label className="field">
              <span>Service Account</span>
              <select name="accountId" required defaultValue="">
                <option value="" disabled>選択してください</option>
                {accounts.filter(a => a.status === 'active').map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>用途</span>
              <select name="scope" value={keyScope} onChange={event => setKeyScope(event.target.value as KeyScope)}>
                {KEY_SCOPE_OPTIONS.map(option => <option key={option.scope} value={option.scope}>{option.label}</option>)}
              </select>
              <small className="muted">{KEY_SCOPE_OPTIONS.find(option => option.scope === keyScope)?.help}</small>
            </label>
            <label className="field"><span>Key名</span><input name="name" placeholder="例: production-2026-08" required /></label>
            {keyScope === 'lineage:write' && (
              <label className="field"><span>許可するNamespace</span><input name="namespaces" placeholder="speech,podcast（カンマ区切り）" required /></label>
            )}
            <button type="submit" className="button primary">一度だけkeyを表示</button>
          </form>
        </section>
      </div>
    </section>
  )
}

function AuditTarget({ event }: { event: AuditEventRow }) {
  return <>{event.details?.target?.displayName ?? event.resource_id ?? event.resource_type ?? '—'}</>
}

function AuditPageView() {
  const [auditEvents, setAuditEvents] = useState<AuditEventRow[]>([])
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openIds, toggleRow] = useOpenRows<number>()
  // 狭い画面では時刻・操作・結果だけを行に残し、操作者と対象は開いた詳細に出す。
  const isNarrow = useMediaQuery(narrowerThan('md'))

  const reload = useCallback(async () => {
    setError(null)
    try {
      const body = await jsonRequest<AuditPage>('/api/internal/audit-events?limit=30')
      setAuditEvents(body.events)
      setNextBeforeId(body.nextBeforeId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '監査ログを取得できませんでした')
    }
  }, [])

  useEffect(() => {
    let current = true
    jsonRequest<AuditPage>('/api/internal/audit-events?limit=30')
      .then(body => {
        if (!current) return
        setAuditEvents(body.events)
        setNextBeforeId(body.nextBeforeId)
      })
      .catch(cause => {
        if (current) setError(cause instanceof Error ? cause.message : '監査ログを取得できませんでした')
      })
    return () => { current = false }
  }, [])

  const loadMore = async () => {
    if (!nextBeforeId || loading) return
    setLoading(true)
    try {
      const body = await jsonRequest<AuditPage>(`/api/internal/audit-events?limit=30&beforeId=${nextBeforeId}`)
      setAuditEvents(current => [...current, ...body.events])
      setNextBeforeId(body.nextBeforeId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '監査ログを取得できませんでした')
    } finally {
      setLoading(false)
    }
  }

  const columnCount = isNarrow ? 4 : 6

  return (
    <section className="admin-audit">
      <div className="admin-toolbar admin-toolbar--end">
        <button type="button" className="button small" onClick={() => void reload()}>
          <RefreshCw size={14} aria-hidden="true" />
          更新
        </button>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {auditEvents.length === 0 ? (
        <p className="state-message">記録はまだありません。</p>
      ) : (
        <div className="table-scroll">
          <table className="responsive-table audit-table">
            <thead>
              <tr>
                <th scope="col">時刻</th>
                {!isNarrow && <th scope="col">操作者</th>}
                <th scope="col">操作</th>
                {!isNarrow && <th scope="col">対象</th>}
                <th scope="col">結果</th>
                <th scope="col" className="responsive-table-toggle"><span className="sr-only">詳細を表示</span></th>
              </tr>
            </thead>
            <tbody>
              {auditEvents.map(event => {
                const isOpen = openIds.has(event.id)
                const detailId = `audit-event-${event.id}`
                const changes = event.details?.changes ?? []
                return [
                  <tr
                    key={event.id}
                    className={isOpen ? 'clickable-row selected' : 'clickable-row'}
                    onClick={clickEvent => { if (!isFromControl(clickEvent)) toggleRow(event.id) }}
                  >
                    <td>
                      <time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString('ja-JP', { hour12: false })}</time>
                    </td>
                    {!isNarrow && <td className="audit-label">{event.actor_label}</td>}
                    <td><span title={event.action}>{ACTION_LABELS[event.action] ?? event.action}</span></td>
                    {!isNarrow && <td className="mono break-word"><AuditTarget event={event} /></td>}
                    <td><span className={`status-badge ${OUTCOME_BADGES[event.outcome]}`}>{OUTCOME_LABELS[event.outcome]}</span></td>
                    <td className="responsive-table-toggle">
                      <RowToggle open={isOpen} controls={detailId} onToggle={() => toggleRow(event.id)} />
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${event.id}-details`} id={detailId} className="responsive-table-details">
                      <td colSpan={columnCount}>
                        <dl className="audit-detail">
                          {isNarrow && (
                            <>
                              <div><dt>操作者</dt><dd>{event.actor_label}</dd></div>
                              <div><dt>対象</dt><dd className="mono"><AuditTarget event={event} /></dd></div>
                            </>
                          )}
                          {changes.map((change, index) => (
                            <div key={`${change.field}-${index}`}>
                              <dt>{change.label ?? change.field}</dt>
                              <dd className="audit-change">
                                <del>{formatAuditValue(change.before)}</del>
                                <span aria-hidden="true">→</span>
                                <ins>{formatAuditValue(change.after)}</ins>
                              </dd>
                            </div>
                          ))}
                          {changes.length === 0 && Object.entries(event.details ?? {})
                            .filter(([key]) => key !== 'target')
                            .map(([key, value]) => (
                              <div key={key}><dt>{key}</dt><dd className="mono">{formatAuditValue(value)}</dd></div>
                            ))}
                        </dl>
                        {(!event.details || Object.keys(event.details).length === 0) && (
                          <p className="muted audit-detail__empty">詳細はありません。</p>
                        )}
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}
      {nextBeforeId && (
        <div className="admin-more">
          <button type="button" className="button small" disabled={loading} onClick={() => void loadMore()}>
            {loading ? '読み込み中…' : 'さらに表示'}
          </button>
        </div>
      )}
    </section>
  )
}

export default function AdminPage() {
  const { user } = useAuth()
  const canUsers = user?.permissions.includes('users:manage') ?? false
  const canAccounts = user?.permissions.includes('service_accounts:manage') ?? false
  const canAudit = user?.permissions.includes('audit:read') ?? false
  const defaultPath = canUsers ? 'users' : canAccounts ? 'service-accounts' : 'audit'

  if (!canUsers && !canAccounts && !canAudit) {
    return <Navigate to="/settings/account" replace />
  }

  return (
    <div className="admin-page">
      <nav className="tabs access-tabs" aria-label="Access">
        {canUsers && <NavLink to="/settings/access/users" className="tab">Users</NavLink>}
        {canAccounts && <NavLink to="/settings/access/service-accounts" className="tab">Service Accounts</NavLink>}
        {canAudit && <NavLink to="/settings/access/audit" className="tab">Audit</NavLink>}
      </nav>
      <Routes>
        <Route index element={<Navigate to={defaultPath} replace />} />
        <Route path="users" element={canUsers ? <UsersPage /> : <Navigate to={defaultPath} replace />} />
        <Route path="service-accounts" element={canAccounts ? <ServiceAccountsPage /> : <Navigate to={defaultPath} replace />} />
        <Route path="audit" element={canAudit ? <AuditPageView /> : <Navigate to={defaultPath} replace />} />
        <Route path="*" element={<Navigate to={defaultPath} replace />} />
      </Routes>
    </div>
  )
}
