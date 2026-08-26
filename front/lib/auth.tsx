import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChangePasswordPage, LoginPage } from '../pages/LoginPage'
import { AuthContext, type AuthUser } from './auth-context'

interface AuthConfig {
  localEnabled: boolean
  oidc: { enabled: boolean; id?: string; label?: string }
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [disabled, setDisabled] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const response = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
    if (response.status === 401) {
      setUser(null)
      return
    }
    if (!response.ok) throw new Error('認証状態を確認できませんでした')
    const body = await response.json() as { user: AuthUser }
    setUser(body.user)
  }, [])

  useEffect(() => {
    let current = true
    ;(async () => {
      try {
        const response = await fetch('/api/auth/config', { headers: { Accept: 'application/json' } })
        if (!current) return
        if (response.status === 404) {
          setDisabled(true)
          return
        }
        if (!response.ok) throw new Error('認証設定を取得できませんでした')
        const next = await response.json() as AuthConfig
        if (!current) return
        setConfig(next)
        await reload()
      } catch (cause) {
        if (current) setError(cause instanceof Error ? cause.message : '認証の初期化に失敗しました')
      } finally {
        if (current) setLoading(false)
      }
    })()
    return () => { current = false }
  }, [reload])

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    setUser(null)
  }, [])
  const value = useMemo(() => ({ enabled: !disabled, user, logout, reload }), [disabled, user, logout, reload])

  if (loading) return <div className="auth-splash">mado.</div>
  if (error) return <div className="auth-splash auth-splash--error">{error}</div>
  if (!disabled && config && !user) return <LoginPage config={config} onLoggedIn={reload} />
  if (!disabled && user?.mustChangePassword) return <ChangePasswordPage onChanged={reload} />
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
