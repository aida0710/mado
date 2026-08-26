import { useCallback, useEffect, useState, type FormEvent } from 'react'

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

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? response.statusText)
  }
  return response.json() as Promise<T>
}

export default function AdminPage() {
  const [users, setUsers] = useState<UserRow[]>([])
  const [accounts, setAccounts] = useState<ServiceAccountRow[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const [userBody, accountBody] = await Promise.all([
        jsonRequest<{ users: UserRow[] }>('/api/internal/users'),
        jsonRequest<{ accounts: ServiceAccountRow[] }>('/api/internal/service-accounts'),
      ])
      setUsers(userBody.users)
      setAccounts(accountBody.accounts)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '管理情報を取得できませんでした')
    }
  }, [])

  useEffect(() => {
    let current = true
    ;(async () => {
      try {
        const [userBody, accountBody] = await Promise.all([
          jsonRequest<{ users: UserRow[] }>('/api/internal/users'),
          jsonRequest<{ accounts: ServiceAccountRow[] }>('/api/internal/service-accounts'),
        ])
        if (!current) return
        setUsers(userBody.users)
        setAccounts(accountBody.accounts)
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : '管理情報を取得できませんでした')
      }
    })()
    return () => { current = false }
  }, [])

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
      <header className="page-head"><h2>Access</h2><p className="page-head__sub">人のログインとPipelineのAPI keyを分離して管理します。</p></header>
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
    </section>
  )
}
