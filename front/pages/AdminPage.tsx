import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { useAuth } from '../lib/auth-context'

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

function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) return value.length ? value.map(formatAuditValue).join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? response.statusText)
  }
  return response.json() as Promise<T>
}

function UsersPage() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<UserRow[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [role, setRole] = useState<RoleId>('viewer')
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const body = await jsonRequest<{ users: UserRow[] }>('/api/internal/users')
      setUsers(body.users)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ユーザーを取得できませんでした')
    }
  }, [])

  useEffect(() => {
    let current = true
    jsonRequest<{ users: UserRow[] }>('/api/internal/users')
      .then(body => { if (current) setUsers(body.users) })
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
      const nextRole = String(form.get('role'))
      if (user.roles.length !== 1 || user.roles[0] !== nextRole) {
        await jsonRequest(`/api/internal/users/${encodeURIComponent(user.id)}/roles`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roles: [nextRole] }),
        })
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

  const deleteUser = async (user: UserRow) => {
    if (!window.confirm(`${user.displayName}を削除しますか？この操作は取り消せません。`)) return
    setError(null)
    setNotice(null)
    try {
      await jsonRequest(`/api/internal/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' })
      setNotice(`${user.displayName}を削除しました。`)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '削除できませんでした')
    }
  }

  return (
    <section className="admin-card admin-card--standalone">
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <div className="admin-notice">{notice}</div>}
      {secret && (
        <div className="admin-secret" role="status">
          <strong>{secret.label} — 今だけ表示されます</strong>
          <code>{secret.value}</code>
          <button type="button" onClick={() => void navigator.clipboard.writeText(secret.value)}>コピー</button>
          <button type="button" onClick={() => setSecret(null)}>閉じる</button>
        </div>
      )}
      {users.length > 0 && (
        <div className="admin-user-list">{users.map(user => (
          <details className="admin-user" key={user.id}>
            <summary>
              <span><strong>{user.displayName}</strong><small>{user.username ?? 'ユーザーID未設定'}{user.email ? ` · ${user.email}` : ''}</small></span>
              <span className="admin-badges">{user.roles.map(role => <em key={role}>{role}</em>)}<em>{user.status}</em></span>
            </summary>
            <form className="admin-form admin-user__form" onSubmit={event => void updateUser(event, user)}>
              <label className="admin-field"><span>表示名</span><input name="displayName" defaultValue={user.displayName} maxLength={128} required /></label>
              <label className="admin-field"><span>ユーザーID（ログインID）</span><input name="username" defaultValue={user.username ?? ''} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" required /></label>
              {user.email && <div className="account-readonly"><span>メールアドレス</span><strong>{user.email}</strong><small>{user.authMethods.includes('sso') ? 'SSO側を正本とし、Madoからは変更できません。' : '認証識別子のため、Madoからは変更できません。'}</small></div>}
              <label className="admin-field"><span>権限</span><select name="role" defaultValue={user.roles[0] ?? 'viewer'}>{ROLE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
              <label className="admin-field"><span>状態</span><select name="status" defaultValue={user.status}><option value="active">Active</option><option value="disabled">Disabled</option></select></label>
              <div className="admin-user__meta"><span>内部ID</span><code>{user.id}</code><span>認証</span><strong>{user.authMethods.join(' + ') || '未設定'}</strong></div>
              <div className="admin-user__actions">
                <button type="submit">保存</button>
                {!(user.authMethods.includes('sso') && !user.authMethods.includes('local')) && <button type="button" className="ghost" onClick={() => void resetPassword(user)}>パスワードを再発行</button>}
                {user.id !== currentUser?.id && <button type="button" className="ghost conn-row__danger" onClick={() => void deleteUser(user)}>削除</button>}
              </div>
            </form>
          </details>
        ))}</div>
      )}
      <form className={`admin-form admin-form--limited${users.length === 0 ? ' admin-form--flush' : ''}`} onSubmit={createUser}>
        <h4>ユーザーを追加</h4>
        <label className="admin-field"><span>表示名</span><input name="displayName" placeholder="例: Mado Curator" required /></label>
        <label className="admin-field"><span>ユーザーID（ログインID）</span><input name="username" placeholder="例: curator" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" required /></label>
        <label className="admin-field"><span>メールアドレス（任意）</span><input name="email" type="email" placeholder="email@example.jp" /></label>
        <label className="admin-field"><span>初回パスワード（12文字以上）</span><input name="password" type="password" minLength={12} autoComplete="new-password" required /></label>
        <label className="admin-field">
          <span>権限</span>
          <select name="role" value={role} onChange={event => setRole(event.target.value as RoleId)}>
            {ROLE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <small className="admin-field__help">{ROLE_OPTIONS.find(option => option.id === role)?.help}</small>
        </label>
        <button type="submit">作成</button>
      </form>
    </section>
  )
}

function ServiceAccountsPage() {
  const [accounts, setAccounts] = useState<ServiceAccountRow[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    const namespaces = String(form.get('namespaces') ?? '').split(',').map(value => value.trim()).filter(Boolean)
    setError(null)
    try {
      const body = await jsonRequest<{ key: { name: string; token: string } }>(
        `/api/internal/service-accounts/${encodeURIComponent(accountId)}/keys`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: form.get('name'), scopes: ['lineage:write'], namespaces }),
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
    <section className="admin-card admin-card--standalone">
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <div className="admin-notice">{notice}</div>}
      {secret && (
        <div className="admin-secret" role="status">
          <strong>{secret.label} — このkeyは今だけ表示されます</strong>
          <code>{secret.value}</code>
          <button type="button" onClick={() => void navigator.clipboard.writeText(secret.value)}>コピー</button>
          <button type="button" onClick={() => setSecret(null)}>閉じる</button>
        </div>
      )}
      {accounts.length > 0 && (
        <div className="admin-list">{accounts.map(account => (
          <div key={account.id}><span><strong>{account.name}</strong><small>{account.description || '説明なし'}</small></span><em>{account.status}</em></div>
        ))}</div>
      )}
      <div className="admin-forms-grid admin-forms-grid--flush">
        <form className="admin-form" onSubmit={createAccount}>
          <h4>Service Accountを追加</h4>
          <label className="admin-field"><span>Service Account名</span><input name="name" placeholder="例: nemo-curator-production" required /></label>
          <label className="admin-field"><span>用途（任意）</span><input name="description" placeholder="例: 音声前処理の本番Pipeline" /></label>
          <button type="submit">作成</button>
        </form>
        <form className="admin-form" onSubmit={issueKey}>
          <h4>OpenLineage APIキーを発行</h4>
          <label className="admin-field"><span>Service Account</span><select name="accountId" required defaultValue=""><option value="" disabled>選択してください</option>{accounts.filter(a => a.status === 'active').map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label className="admin-field"><span>Key名</span><input name="name" placeholder="例: production-2026-08" required /></label>
          <label className="admin-field"><span>許可するNamespace</span><input name="namespaces" placeholder="speech,podcast（カンマ区切り）" required /></label>
          <button type="submit">一度だけkeyを表示</button>
        </form>
      </div>
    </section>
  )
}

function AuditPageView() {
  const [auditEvents, setAuditEvents] = useState<AuditEventRow[]>([])
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <section className="admin-card admin-card--standalone admin-audit">
      <div className="admin-audit__actions">
        <button type="button" className="ghost" onClick={() => void reload()}>更新</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="admin-audit__columns" aria-hidden="true">
        <span>時刻</span><span>ユーザー</span><span>操作</span><span>対象</span><span>結果</span>
      </div>
      <div className="admin-audit__list">
        {auditEvents.map(event => (
          <details key={event.id} className="admin-audit__event" data-outcome={event.outcome}>
            <summary>
              <time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString('ja-JP', { hour12: false })}</time>
              <strong>{event.actor_label}</strong>
              <span>{ACTION_LABELS[event.action] ?? event.action}</span>
              <code>{event.details?.target?.displayName ?? event.resource_id ?? event.resource_type ?? '—'}</code>
              <em>{OUTCOME_LABELS[event.outcome]}</em>
            </summary>
            <div className="admin-audit__detail">
              {event.details?.changes?.map((change, index) => (
                <div key={`${change.field}-${index}`}>
                  <strong>{change.label ?? change.field}</strong>
                  <span><del>{formatAuditValue(change.before)}</del><i>→</i><ins>{formatAuditValue(change.after)}</ins></span>
                </div>
              ))}
              {(!event.details?.changes || event.details.changes.length === 0) && (
                <dl>{Object.entries(event.details ?? {}).filter(([key]) => key !== 'target').map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{formatAuditValue(value)}</dd></div>)}</dl>
              )}
              {(!event.details || Object.keys(event.details).length === 0) && <p>詳細はありません。</p>}
            </div>
          </details>
        ))}
        {auditEvents.length === 0 && <p>記録はまだありません。</p>}
      </div>
      {nextBeforeId && <button type="button" className="ghost admin-audit__more" disabled={loading} onClick={() => void loadMore()}>{loading ? '読み込み中…' : 'さらに表示'}</button>}
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
    <section className="admin-page admin-page--embedded">
      <nav className="access-tabs" aria-label="Access">
        {canUsers && <NavLink to="/settings/access/users" className={({ isActive }) => `access-tabs__link${isActive ? ' is-active' : ''}`}>Users</NavLink>}
        {canAccounts && <NavLink to="/settings/access/service-accounts" className={({ isActive }) => `access-tabs__link${isActive ? ' is-active' : ''}`}>Service Accounts</NavLink>}
        {canAudit && <NavLink to="/settings/access/audit" className={({ isActive }) => `access-tabs__link${isActive ? ' is-active' : ''}`}>Audit</NavLink>}
      </nav>
      <div className="access-content">
          <Routes>
            <Route index element={<Navigate to={defaultPath} replace />} />
            <Route path="users" element={canUsers ? <UsersPage /> : <Navigate to={defaultPath} replace />} />
            <Route path="service-accounts" element={canAccounts ? <ServiceAccountsPage /> : <Navigate to={defaultPath} replace />} />
            <Route path="audit" element={canAudit ? <AuditPageView /> : <Navigate to={defaultPath} replace />} />
            <Route path="*" element={<Navigate to={defaultPath} replace />} />
          </Routes>
      </div>
    </section>
  )
}
