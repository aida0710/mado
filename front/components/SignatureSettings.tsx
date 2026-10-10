import { useState, type FormEvent } from 'react'
import { LogOut } from 'lucide-react'
import { fetchApi } from '../lib/api/http'
import { getEditorName, setEditorName } from '../lib/editorName'
import { useAuth } from '../lib/auth-context'
import { SettingsSectionHeader } from './SettingsSectionHeader'

export function SignatureSettings() {
  const auth = useAuth()
  const [displayName, setDisplayName] = useState(() => auth.user?.displayName ?? '')
  const [username, setUsername] = useState(() => auth.user?.username ?? '')
  const [signatureName, setSignatureName] = useState(() => auth.user?.signatureName ?? getEditorName())
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  const commit = async () => {
    const nextDisplayName = displayName.trim()
    const nextUsername = username.trim()
    const nextSignatureName = signatureName.trim()
    if (!nextSignatureName || (auth.enabled && (!nextDisplayName || !nextUsername))) return
    setSaving(true)
    setError(null)
    try {
      if (auth.enabled) {
        const response = await fetchApi('/api/auth/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: nextDisplayName,
            username: nextUsername,
            signatureName: nextSignatureName,
          }),
        })
        const body = await response.json().catch(() => null) as { error?: string } | null
        if (!response.ok) throw new Error(body?.error ?? 'アカウントを保存できませんでした')
        await auth.reload()
      } else {
        setEditorName(nextSignatureName)
      }
      setDisplayName(nextDisplayName)
      setUsername(nextUsername)
      setSignatureName(nextSignatureName)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'アカウントを保存できませんでした')
    } finally {
      setSaving(false)
    }
  }

  const changePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const currentPassword = String(data.get('currentPassword') ?? '')
    const newPassword = String(data.get('newPassword') ?? '')
    const confirmation = String(data.get('confirmation') ?? '')
    if (newPassword !== confirmation) {
      setError('新しいパスワードが一致しません')
      return
    }
    setPasswordBusy(true)
    setPasswordNotice(null)
    setError(null)
    try {
      const response = await fetchApi('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (!response.ok) throw new Error('パスワードを変更できませんでした')
      form.reset()
      await auth.reload()
      setPasswordNotice('パスワードを変更しました')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'パスワードを変更できませんでした')
    } finally {
      setPasswordBusy(false)
    }
  }

  const logout = async () => {
    setLoggingOut(true)
    setLogoutError(null)
    try {
      await auth.logout()
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : 'サインアウトできませんでした')
    } finally {
      setLoggingOut(false)
    }
  }

  const canSave = !saving && signatureName.trim() !== '' && (!auth.enabled || (displayName.trim() !== '' && username.trim() !== ''))

  return (
    <section className="account-settings settings-column">
      <SettingsSectionHeader title="アカウントと署名の管理" />

      <form className="account-form" onSubmit={event => { event.preventDefault(); void commit() }}>
        {auth.enabled && (
          <>
            <label className="field">
              <span>表示名</span>
              <input value={displayName} onChange={event => { setDisplayName(event.target.value); setSaved(false) }} maxLength={128} autoComplete="name" required />
            </label>
            <label className="field">
              <span>ユーザーID（ログインID）</span>
              <input value={username} onChange={event => { setUsername(event.target.value); setSaved(false) }} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" autoComplete="username" required />
            </label>
            {auth.user?.email && (
              <div className="field readonly-field">
                <span>メールアドレス</span>
                <strong className="mono">{auth.user.email}</strong>
                <small className="muted">
                  {auth.user.authMethods?.includes('sso') ? 'SSO側で管理されるため、Madoからは変更できません。' : '認証識別子のため、Madoからは変更できません。'}
                </small>
              </div>
            )}
          </>
        )}
        <label className="field">
          <span>署名</span>
          <input value={signatureName} onChange={event => { setSignatureName(event.target.value); setSaved(false) }} maxLength={128} placeholder="e.g. tanaka" autoComplete="nickname" aria-label="署名名" required />
          <small className="muted">README・共有ノートの編集者として、このアカウントの履歴に記録されます。</small>
        </label>
        <div className="form-submit-row">
          <button type="submit" className="button primary" disabled={!canSave}>{saving ? '保存中…' : '保存'}</button>
          {saved && <span className="form-submit-row__status" role="status">保存しました</span>}
        </div>
      </form>
      {error && <p className="notice error" role="alert">{error}</p>}

      {auth.enabled && (
        <>
          {auth.user?.authMethods?.includes('local') !== false && (
            <details className="account-password">
              <summary>パスワードを変更</summary>
              <form className="account-form" onSubmit={changePassword}>
                <label className="field"><span>現在のパスワード</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
                <label className="field"><span>新しいパスワード（12文字以上）</span><input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
                <label className="field"><span>新しいパスワード（確認）</span><input name="confirmation" type="password" autoComplete="new-password" minLength={12} required /></label>
                <div className="form-submit-row">
                  <button type="submit" className="button primary" disabled={passwordBusy}>{passwordBusy ? '変更中…' : '変更'}</button>
                  {passwordNotice && <span className="form-submit-row__status" role="status">{passwordNotice}</span>}
                </div>
              </form>
            </details>
          )}
          <div className="account-signout">
            <button type="button" className="button" onClick={() => void logout()} disabled={loggingOut}>
              <LogOut size={14} aria-hidden="true" />
              {loggingOut ? 'サインアウト中…' : 'サインアウト'}
            </button>
            {logoutError && <p className="notice error" role="alert">{logoutError}</p>}
          </div>
        </>
      )}
    </section>
  )
}
