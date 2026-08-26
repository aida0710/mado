import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../lib/auth-context'

interface UserRow {
  id: string
  username: string | null
  email: string | null
  displayName: string
  status: 'active' | 'disabled'
  roles: string[]
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
  outcome: 'success' | 'denied' | 'failure'
}

interface AuditPage {
  events: AuditEventRow[]
  nextBeforeId: number | null
}

const ACTION_LABELS: Record<string, string> = {
  'auth.local.login': 'ログイン',
  'auth.oidc.login': 'SSOログイン',
  'auth.logout': 'ログアウト',
  'auth.password.change': 'パスワード変更',
  'auth.profile.update': 'アカウント設定変更',
  'connection.create': '接続を追加',
  'connection.update': '接続を変更',
  'connection.delete': '接続を削除',
  'connection.default.set': 'デフォルト接続を変更',
  'note.update': '共有ノートを保存',
  'storage.readme.update': 'READMEを保存',
  'storage.scan.start': '走査を開始',
  'storage.tag.assign': 'タグを付与',
  'storage.tag.remove': 'タグを解除',
  'storage.favorite.add': 'お気に入りへ追加',
  'storage.favorite.remove': 'お気に入りから削除',
  'storage.download.raw': 'ファイルをダウンロード',
  'storage.download.tar': 'アーカイブをダウンロード',
  'storage.download.tar-entry': 'アーカイブ内をダウンロード',
  'tag.create': 'タグを作成',
  'tag.update': 'タグを変更',
  'tag.delete': 'タグを削除',
  'setting.update': '設定を変更',
  'pricing.refresh': '料金を更新',
  'job.cancel': 'ジョブを中断',
  'service_account.create': 'Service Accountを作成',
  'service_account.update': 'Service Accountを変更',
  'service_account.key.issue': 'API keyを発行',
  'service_account.key.revoke': 'API keyを失効',
  'user.create': 'ユーザーを作成',
  'user.update': 'ユーザーを変更',
  'user.roles.update': 'ユーザー権限を変更',
  'user.password.reset': 'パスワードを再発行',
  'user.manage': 'ユーザー操作',
  'service_account.manage': 'Service Account操作',
  'audit.read': '監査ログを表示',
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? response.statusText)
  }
  return response.json() as Promise<T>
}

export default function AdminPage() {
  const auth = useAuth()
  const canReadAudit = auth.user?.permissions.includes('audit:read') ?? false
  const [users, setUsers] = useState<UserRow[]>([])
  const [accounts, setAccounts] = useState<ServiceAccountRow[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEventRow[]>([])
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [userBody, accountBody, auditBody] = await Promise.all([
        jsonRequest<{ users: UserRow[] }>('/api/internal/users'),
        jsonRequest<{ accounts: ServiceAccountRow[] }>('/api/internal/service-accounts'),
        canReadAudit ? jsonRequest<AuditPage>('/api/internal/audit-events?limit=30') : Promise.resolve(null),
      ])
      setUsers(userBody.users)
      setAccounts(accountBody.accounts)
      if (auditBody) {
        setAuditEvents(auditBody.events)
        setNextBeforeId(auditBody.nextBeforeId)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '管理情報を取得できませんでした')
    }
  }, [canReadAudit])

  useEffect(() => {
    let current = true
    ;(async () => {
      try {
        const [userBody, accountBody, auditBody] = await Promise.all([
          jsonRequest<{ users: UserRow[] }>('/api/internal/users'),
          jsonRequest<{ accounts: ServiceAccountRow[] }>('/api/internal/service-accounts'),
          canReadAudit ? jsonRequest<AuditPage>('/api/internal/audit-events?limit=30') : Promise.resolve(null),
        ])
        if (!current) return
        setUsers(userBody.users)
        setAccounts(accountBody.accounts)
        if (auditBody) {
          setAuditEvents(auditBody.events)
          setNextBeforeId(auditBody.nextBeforeId)
        }
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : '管理情報を取得できませんでした')
      }
    })()
    return () => { current = false }
  }, [canReadAudit])

  const loadMoreAudit = async () => {
    if (!nextBeforeId || auditLoading) return
    setAuditLoading(true)
    try {
      const body = await jsonRequest<AuditPage>(`/api/internal/audit-events?limit=30&beforeId=${nextBeforeId}`)
      setAuditEvents(current => [...current, ...body.events])
      setNextBeforeId(body.nextBeforeId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '監査ログを取得できませんでした')
    } finally {
      setAuditLoading(false)
    }
  }

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    try {
      await jsonRequest('/api/internal/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: form.get('username'), email: form.get('email') || null, displayName: form.get('displayName'),
          password: form.get('password'), roles: [form.get('role')],
        }),
      })
      event.currentTarget.reset()
      setNotice('Local Userを作成しました。初回ログイン時にパスワード変更が必要です。')
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '作成できませんでした') }
  }

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError(null)
    try {
      await jsonRequest('/api/internal/service-accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.get('name'), description: form.get('description') }),
      })
      event.currentTarget.reset()
      setNotice('Service Accountを作成しました。')
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '作成できませんでした') }
  }

  const issueKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
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
      event.currentTarget.reset()
      setNotice(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'keyを発行できませんでした') }
  }

  return (
    <section className="admin-page">
      <header className="page-head"><h2>Access</h2></header>
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

      <div className="admin-grid">
        <section className="admin-card">
          <h3>Local Users</h3>
          <div className="admin-list">{users.map(user => (
            <div key={user.id}><span><strong>{user.displayName}</strong><small>{user.username}{user.email ? ` · ${user.email}` : ''}</small></span><span className="admin-badges">{user.roles.map(role => <em key={role}>{role}</em>)}</span></div>
          ))}</div>
          <form className="admin-form" onSubmit={createUser}>
            <h4>ユーザーを追加</h4>
            <label className="admin-field"><span>表示名</span><input name="displayName" placeholder="例: Mado Curator" required /></label>
            <label className="admin-field"><span>ユーザー名</span><input name="username" placeholder="例: curator" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" required /></label>
            <label className="admin-field"><span>メールアドレス（任意）</span><input name="email" type="email" placeholder="email@example.jp" /></label>
            <label className="admin-field"><span>初回パスワード（12文字以上）</span><input name="password" type="password" minLength={12} autoComplete="new-password" required /></label>
            <label className="admin-field"><span>権限</span><select name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="curator">Curator</option><option value="operator">Operator</option><option value="admin">Admin</option></select></label>
            <button type="submit">作成</button>
          </form>
        </section>

        <section className="admin-card">
          <h3>Pipeline Service Accounts</h3>
          <div className="admin-list">{accounts.map(account => (
            <div key={account.id}><span><strong>{account.name}</strong><small>{account.description || '説明なし'}</small></span><em>{account.status}</em></div>
          ))}</div>
          <form className="admin-form" onSubmit={createAccount}>
            <h4>Accountを追加</h4>
            <label className="admin-field"><span>Account名</span><input name="name" placeholder="例: nemo-curator-production" required /></label>
            <label className="admin-field"><span>用途（任意）</span><input name="description" placeholder="例: 音声前処理の本番Pipeline" /></label>
            <button type="submit">作成</button>
          </form>
          <form className="admin-form" onSubmit={issueKey}>
            <h4>Lineage API keyを発行</h4>
            <label className="admin-field"><span>Service Account</span><select name="accountId" required defaultValue=""><option value="" disabled>選択してください</option>{accounts.filter(a => a.status === 'active').map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            <label className="admin-field"><span>Key名</span><input name="name" placeholder="例: production-2026-08" required /></label>
            <label className="admin-field"><span>許可するNamespace</span><input name="namespaces" placeholder="speech,podcast（カンマ区切り）" required /></label>
            <button type="submit">一度だけkeyを表示</button>
          </form>
        </section>
      </div>

      {canReadAudit && <section className="admin-card admin-audit">
        <div className="admin-audit__head">
          <h3>監査ログ</h3>
          <button type="button" className="ghost" onClick={() => void reload()}>更新</button>
        </div>
        <div className="admin-audit__list">
          {auditEvents.map(event => (
            <article key={event.id} data-outcome={event.outcome}>
              <time dateTime={event.occurred_at}>{new Date(event.occurred_at).toLocaleString('ja-JP', { hour12: false })}</time>
              <strong>{event.actor_label}</strong>
              <span>{ACTION_LABELS[event.action] ?? event.action}</span>
              <code>{event.resource_id ?? event.resource_type ?? '—'}</code>
              <em>{event.outcome}</em>
            </article>
          ))}
          {auditEvents.length === 0 && <p>記録はまだありません。</p>}
        </div>
        {nextBeforeId && <button type="button" className="ghost admin-audit__more" disabled={auditLoading} onClick={() => void loadMoreAudit()}>{auditLoading ? '読み込み中…' : 'さらに表示'}</button>}
      </section>}
    </section>
  )
}
