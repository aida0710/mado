import { useState, type FormEvent } from 'react'
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

  const commit = async () => {
    const nextDisplayName = displayName.trim()
    const nextUsername = username.trim()
    const nextSignatureName = signatureName.trim()
    if (!nextSignatureName || (auth.enabled && (!nextDisplayName || !nextUsername))) return
    setSaving(true)
    setError(null)
    try {
      if (auth.enabled) {
        const response = await fetch('/api/auth/profile', {
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
      const response = await fetch('/api/auth/change-password', {
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

  return (
    <section className="mt-7">
      <SettingsSectionHeader title="アカウントと署名の管理" />

      <form className="admin-form account-profile" onSubmit={event => { event.preventDefault(); void commit() }}>
        {auth.enabled && (
          <>
            <label className="admin-field"><span>表示名</span><input value={displayName} onChange={event => { setDisplayName(event.target.value); setSaved(false) }} maxLength={128} autoComplete="name" required /></label>
            <label className="admin-field"><span>ユーザーID（ログインID）</span><input value={username} onChange={event => { setUsername(event.target.value); setSaved(false) }} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" autoComplete="username" required /></label>
            {auth.user?.email && <div className="account-readonly"><span>メールアドレス</span><strong>{auth.user.email}</strong><small>{auth.user.authMethods?.includes('sso') ? 'SSO側で管理されるため、Madoからは変更できません。' : '認証識別子のため、Madoからは変更できません。'}</small></div>}
          </>
        )}
        <label className="admin-field"><span>署名</span><input value={signatureName} onChange={event => { setSignatureName(event.target.value); setSaved(false) }} maxLength={128} placeholder="e.g. tanaka" autoComplete="nickname" aria-label="署名名" required /></label>
        <div className="account-profile__actions">
          <button type="submit" disabled={saving || !signatureName.trim() || (auth.enabled && (!displayName.trim() || !username.trim()))}>{saving ? '保存中…' : '保存'}</button>
          {saved && <span>保存しました</span>}
        </div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="px-1 text-[12px] text-ink-7">
        README・共有ノートの編集者として、このアカウントの履歴に記録されます。
      </p>

      {auth.enabled && (
        <>
          {auth.user?.authMethods?.includes('local') !== false && <details className="account-password">
            <summary>パスワードを変更</summary>
            <form className="admin-form" onSubmit={changePassword}>
              <label className="admin-field"><span>現在のパスワード</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
              <label className="admin-field"><span>新しいパスワード（12文字以上）</span><input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
              <label className="admin-field"><span>新しいパスワード（確認）</span><input name="confirmation" type="password" autoComplete="new-password" minLength={12} required /></label>
              <button type="submit" disabled={passwordBusy}>{passwordBusy ? '変更中…' : '変更'}</button>
            </form>
            {passwordNotice && <p className="account-password__notice">{passwordNotice}</p>}
          </details>}
          <div className="account-signout">
            <button type="button" className="ghost" onClick={() => void auth.logout()}>
              サインアウト
            </button>
          </div>
        </>
      )}
    </section>
  )
}
