import { useState, type FormEvent } from 'react'
import { ProductName } from '../components/shell/ProductName'
import { fetchApi } from '../lib/api/http'

/** ログイン画面とパスワード変更画面の見出しの id。重ねて出すときの dialog の名前にも使う。 */
export const AUTH_TITLE_ID = 'auth-title'

interface Props {
  config: {
    localEnabled: boolean
    oidc: { enabled: boolean; label?: string }
  }
  /** ログイン中に session が切れて、この画面へ戻されたか。 */
  sessionExpired?: boolean
  /** サインアウトしたが、SSO 側のサインアウトができなかったか。 */
  idpLogoutIncomplete?: boolean
  /**
   * 開いていた画面を残したまま、その上に重ねて出しているか。SSO はページを開き直すので、
   * 同じタブで進むと残した画面が消える。重ねているときは SSO を新しいタブで開く。
   */
  overlay?: boolean
  onLoggedIn(): Promise<void>
}

export function LoginPage({
  config, sessionExpired = false, idpLogoutIncomplete = false, overlay = false, onLoggedIn,
}: Props) {
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

  // 重ねているときの SSO は新しいタブで開く。そのタブで同じ編集画面を開くと、同じ本文を
  // 2 つのエディタで書き換えかねないので、ログインのあとはホームを開く。
  const returnTo = overlay ? '/' : `${location.pathname}${location.search}${location.hash}`
  const oidcUrl = `/api/auth/oidc/start?returnTo=${encodeURIComponent(returnTo)}`

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby={AUTH_TITLE_ID}>
        <div className="login-mark"><ProductName /></div>
        <h1 id={AUTH_TITLE_ID}>ログイン</h1>
        {(sessionExpired || idpLogoutIncomplete || overlay) && (
          <div className="login-lead">
            {sessionExpired && <p role="status">セッションが切れました。もう一度ログインしてください。</p>}
            {idpLogoutIncomplete && (
              <p role="status">
                {`Madoからはサインアウトしました。${config.oidc.label ?? 'SSO'}側のサインアウトはできていません。共用のパソコンでは、ブラウザを閉じてください。`}
              </p>
            )}
            {overlay && <p>同じアカウントでログインすると、開いていた画面に戻ります。</p>}
          </div>
        )}

        {config.oidc.enabled && (
          <>
            <a
              className="button primary"
              href={oidcUrl}
              target={overlay ? '_blank' : undefined}
              rel={overlay ? 'noopener' : undefined}
            >
              {config.oidc.label ?? 'SSO'}で続行
            </a>
            {overlay && (
              <p className="login-note">新しいタブでログインします。ログインが済んだら、このタブに戻ってください。</p>
            )}
          </>
        )}
        {config.oidc.enabled && config.localEnabled && <div className="login-or"><span>または</span></div>}

        {config.localEnabled && (
          <form onSubmit={login}>
            <label className="field"><span>ユーザー名またはメールアドレス</span><input name="identifier" autoComplete="username" required /></label>
            <label className="field"><span>パスワード</span><input name="password" type="password" autoComplete="current-password" required /></label>
            {error && <p className="notice error" role="alert">{error}</p>}
            <button type="submit" className="button primary" disabled={busy}>{busy ? '確認中…' : 'ログイン'}</button>
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
      // ログイン済み（session がある）なので、401 は session が切れたことを表す。fetchApi で
      // AuthGate へ知らせ、ログイン画面へ戻す。現在のパスワードの誤りは 400 なので知らせない。
      const response = await fetchApi('/api/auth/change-password', {
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
    <main className="login-page">
      <section className="login-card" aria-labelledby={AUTH_TITLE_ID}>
        <div className="login-mark"><ProductName /></div>
        <p className="login-eyebrow">First sign-in</p>
        <h1 id={AUTH_TITLE_ID}>パスワードを変更</h1>
        <div className="login-lead"><p>初回ログイン用パスワードはこの画面で更新してください。</p></div>
        <form onSubmit={submit}>
          <label className="field"><span>現在のパスワード</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
          <label className="field"><span>新しいパスワード（12文字以上）</span><input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
          <label className="field"><span>新しいパスワード（確認）</span><input name="confirmation" type="password" autoComplete="new-password" minLength={12} required /></label>
          {error && <p className="notice error" role="alert">{error}</p>}
          <button type="submit" className="button primary" disabled={busy}>{busy ? '更新中…' : '変更して続行'}</button>
        </form>
      </section>
    </main>
  )
}
