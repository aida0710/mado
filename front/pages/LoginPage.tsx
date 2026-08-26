import { useState, type FormEvent } from 'react'

interface Props {
  config: {
    localEnabled: boolean
    oidc: { enabled: boolean; label?: string }
  }
  onLoggedIn(): Promise<void>
}

export function LoginPage({ config, onLoggedIn }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/local/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: form.get('identifier'), password: form.get('password') }),
      })
      if (!response.ok) throw new Error('ユーザー名・メールアドレスまたはパスワードが違います')
      await onLoggedIn()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ログインできませんでした')
    } finally {
      setBusy(false)
    }
  }

  const returnTo = `${location.pathname}${location.search}${location.hash}`
  const oidcUrl = `/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-card__mark">mado<span>.</span></div>
        <p className="auth-card__eyebrow">DATA CATALOG</p>
        <h1 id="auth-title">データの窓口へログイン</h1>
        <p className="auth-card__lead">StorageとLineageを同じ権限境界で安全に扱います。</p>

        {config.oidc.enabled && (
          <a className="auth-card__sso" href={oidcUrl}>{config.oidc.label ?? 'SSO'}で続行</a>
        )}
        {config.oidc.enabled && config.localEnabled && <div className="auth-card__or"><span>または</span></div>}

        {config.localEnabled && (
          <form onSubmit={login} className="auth-form">
            <label><span>ユーザー名またはメールアドレス</span><input name="identifier" autoComplete="username" required /></label>
            <label><span>パスワード</span><input name="password" type="password" autoComplete="current-password" required /></label>
            {error && <p className="auth-form__error" role="alert">{error}</p>}
            <button type="submit" disabled={busy}>{busy ? '確認中…' : 'ログイン'}</button>
          </form>
        )}
      </section>
    </main>
  )
}

export function ChangePasswordPage({ onChanged }: { onChanged(): Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const currentPassword = String(form.get('currentPassword') ?? '')
    const newPassword = String(form.get('newPassword') ?? '')
    const confirmation = String(form.get('confirmation') ?? '')
    if (newPassword !== confirmation) {
      setError('新しいパスワードが一致しません')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (!response.ok) throw new Error('パスワードを変更できませんでした')
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'パスワードを変更できませんでした')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-card__mark">mado<span>.</span></div>
        <p className="auth-card__eyebrow">FIRST SIGN-IN</p>
        <h1>パスワードを変更</h1>
        <p className="auth-card__lead">初回ログイン用パスワードはこの画面で更新してください。</p>
        <form onSubmit={submit} className="auth-form">
          <label><span>現在のパスワード</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
          <label><span>新しいパスワード（12文字以上）</span><input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
          <label><span>新しいパスワード（確認）</span><input name="confirmation" type="password" autoComplete="new-password" minLength={12} required /></label>
          {error && <p className="auth-form__error" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? '更新中…' : '変更して続行'}</button>
        </form>
      </section>
    </main>
  )
}
