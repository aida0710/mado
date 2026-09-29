import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChangePasswordPage, LoginPage } from '../pages/LoginPage'
import { clearAllCaches } from './api/cache'
import { subscribeUnauthorized } from './api/unauthorized-events'
import { AuthContext, type AuthUser } from './auth-context'

interface AuthConfig {
  localEnabled: boolean
  oidc: { enabled: boolean; id?: string; label?: string }
}

/** 今の session の User。session が無い・切れていれば null。 */
async function fetchCurrentUser(): Promise<AuthUser | null> {
  const response = await fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
  if (response.status === 401) return null
  if (!response.ok) throw new Error('認証状態を確認できませんでした')
  const body = await response.json() as { user: AuthUser }
  return body.user
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [disabled, setDisabled] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // ログイン中に session が切れてログイン画面へ戻したか。ログイン画面で理由を伝えるのに使う。
  const [sessionExpired, setSessionExpired] = useState(false)
  const confirmingSessionRef = useRef(false)

  // 画面をログアウト状態にする。同じブラウザを次に使う人へ前の User の一覧や README を
  // 残さないよう、キャッシュも消す。
  const logoutLocally = useCallback(() => {
    clearAllCaches()
    setUser(null)
  }, [])

  const reload = useCallback(async () => {
    const currentUser = await fetchCurrentUser()
    if (!currentUser) {
      logoutLocally()
      return
    }
    setSessionExpired(false)
    setUser(currentUser)
  }, [logoutLocally])

  // API が 401 を返したときに、session が本当に切れたかを確かめる。
  const confirmSessionAfterUnauthorized = useCallback(async () => {
    // 画面の各パネルが同時に 401 を受けても、確認は 1 回にまとめる。
    if (confirmingSessionRef.current) return
    confirmingSessionRef.current = true
    try {
      // session が有効なら画面はそのまま残す。setUser し直すと画面全体が描き直され、
      // 同じ API を呼び直して 401 を繰り返すおそれがある。
      if (await fetchCurrentUser()) return
      setSessionExpired(true)
      logoutLocally()
    } catch {
      // /api/auth/me にも届かないときは session の状態が分からないので、画面を残す。
    } finally {
      confirmingSessionRef.current = false
    }
  }, [logoutLocally])

  // ログイン中だけ 401 を受け取る。認証が無効ならログイン画面が無いので受け取らない。
  // ログイン画面の表示中も受け取らない（パスワード誤りの 401 などで確認を繰り返さないため）。
  const signedIn = user !== null
  useEffect(() => {
    if (disabled || !signedIn) return
    return subscribeUnauthorized(() => { void confirmSessionAfterUnauthorized() })
  }, [disabled, signedIn, confirmSessionAfterUnauthorized])

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

  // サーバーが session を消せたときだけ画面をログアウト状態にする。失敗したら
  // ログイン状態を保ったまま、利用者に見せる文言の Error で reject する。
  const logout = useCallback(async () => {
    let response: Response
    try {
      response = await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      // 要求がサーバーに届いて session を失効させたあとで通信が切れた可能性もあるので、
      // 「ログイン状態のまま」とは言い切らない。
      throw new Error('サーバーに接続できず、サインアウトできたか確認できませんでした。もう一度お試しください。')
    }
    // /logout は sessionGuard の後ろにあるので、401 は session がもう無いことを表す。
    if (response.status === 401) {
      logoutLocally()
      return
    }
    // /logout は session を失効させられれば、IdP の logout URL を作れなくても 200 を返す。
    // したがってそれ以外の失敗は、session が残っていることを表す。
    if (!response.ok) {
      throw new Error(`サインアウトできませんでした（HTTP ${response.status}）。ログイン状態のままです。時間をおいてもう一度お試しください。`)
    }
    const body = await response.json().catch(() => null) as { logoutUrl?: string | null } | null
    logoutLocally()
    if (body?.logoutUrl) window.location.assign(body.logoutUrl)
  }, [logoutLocally])
  const value = useMemo(() => ({ enabled: !disabled, user, logout, reload }), [disabled, user, logout, reload])

  if (loading) return <div className="auth-splash">mado.</div>
  if (error) return <div className="auth-splash auth-splash--error">{error}</div>
  if (!disabled && config && !user) {
    return <LoginPage config={config} sessionExpired={sessionExpired} onLoggedIn={reload} />
  }
  if (!disabled && user?.mustChangePassword) return <ChangePasswordPage onChanged={reload} />
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
