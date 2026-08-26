import { useState, type FormEvent } from 'react'
import { getEditorName, setEditorName } from '../lib/editorName'
import { useAuth } from '../lib/auth-context'
import { SettingsSectionHeader } from './SettingsSectionHeader'

export function SignatureSettings() {
  const auth = useAuth()
  const [name, setName] = useState(() => auth.user?.signatureName ?? getEditorName())
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)

  const commit = async () => {
    const next = name.trim()
    if (!next) return
    setSaving(true)
    setError(null)
    try {
      if (auth.enabled) {
        const response = await fetch('/api/auth/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signatureName: next }),
        })
        if (!response.ok) throw new Error('署名を保存できませんでした')
        await auth.reload()
      } else {
        setEditorName(next)
      }
      setName(next)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '署名を保存できませんでした')
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

      {auth.user && (
        <dl className="account-summary">
          <div><dt>表示名</dt><dd>{auth.user.displayName}</dd></div>
          <div><dt>ユーザー名</dt><dd>{auth.user.username ?? auth.user.email ?? '—'}</dd></div>
        </dl>
      )}

      <form className="flex flex-wrap items-center gap-2 px-1 py-2" onSubmit={event => { event.preventDefault(); void commit() }}>
        <label className="contents">
        <span className="text-[13px] text-ink-11">署名</span>
        <input
          value={name}
          onChange={e => { setName(e.target.value); setSaved(false) }}
          placeholder="e.g. tanaka"
          autoComplete="nickname"
          aria-label="署名名"
        />
        </label>
        <button type="submit" className="ghost" disabled={saving || name.trim() === ''}>
          {saving ? '保存中…' : '保存'}
        </button>
        {saved && <span className="text-[12px] text-ink-7">保存しました</span>}
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="px-1 text-[12px] text-ink-7">
        README・共有ノートの編集者として、このアカウントの履歴に記録されます。
      </p>

      {auth.enabled && (
        <>
          <details className="account-password">
            <summary>パスワードを変更</summary>
            <form className="admin-form" onSubmit={changePassword}>
              <label className="admin-field"><span>現在のパスワード</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label>
              <label className="admin-field"><span>新しいパスワード（12文字以上）</span><input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></label>
              <label className="admin-field"><span>新しいパスワード（確認）</span><input name="confirmation" type="password" autoComplete="new-password" minLength={12} required /></label>
              <button type="submit" disabled={passwordBusy}>{passwordBusy ? '変更中…' : '変更'}</button>
            </form>
            {passwordNotice && <p className="account-password__notice">{passwordNotice}</p>}
          </details>
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
