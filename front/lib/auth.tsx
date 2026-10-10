import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { AuthOverlay } from '../components/AuthOverlay'
import { AUTH_TITLE_ID, ChangePasswordPage, LoginPage } from '../pages/LoginPage'
import { clearAllCaches } from './api/cache'
import { subscribeUnauthorized } from './api/unauthorized-events'
import { AuthContext, type AuthUser } from './auth-context'
import { nextAuthSession, SIGNED_OUT, type AuthSessionState } from './auth-session-state'

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

/** session が無ければログイン画面、パスワードを変える必要があれば変更画面。どちらも要らなければ null。 */
function authPageFor({ config, session, onSessionChanged }: {
  config: AuthConfig
  session: AuthSessionState
  onSessionChanged(): Promise<void>
}): ReactNode {
  if (!session.user) {
    return (
      <LoginPage
        config={config}
        sessionExpired={session.sessionExpired}
        idpLogoutIncomplete={session.idpLogoutIncomplete}
        overlay={session.screenUser !== null}
        onLoggedIn={onSessionChanged}
      />
    )
  }
  if (session.user.mustChangePassword) return <ChangePasswordPage onChanged={onSessionChanged} />
  return null
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [disabled, setDisabled] = useState(false)
  const [session, dispatchSession] = useReducer(nextAuthSession, SIGNED_OUT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const confirmingSessionRef = useRef(false)

  // /api/auth/me で確かめた User を反映する。session が無ければ、同じブラウザを次に使う人へ
  // 前の User の一覧や README を残さないよう、キャッシュも消す。
  const applyCurrentUser = useCallback((currentUser: AuthUser | null) => {
    if (!currentUser) clearAllCaches()
    dispatchSession({ type: 'checked', user: currentUser })
  }, [])

  // 画面をログアウト状態にする。キャッシュも消す（理由は applyCurrentUser と同じ）。
  const logoutLocally = useCallback(({ idpLogoutUnavailable = false }: { idpLogoutUnavailable?: boolean } = {}) => {
    clearAllCaches()
    dispatchSession({ type: 'loggedOut', idpLogoutUnavailable })
  }, [])

  const reload = useCallback(async () => {
    applyCurrentUser(await fetchCurrentUser())
  }, [applyCurrentUser])

  // API が 401 を返したときに、session が本当に切れたかを確かめる。
  const confirmSessionAfterUnauthorized = useCallback(async () => {
    // 画面の各パネルが同時に 401 を受けても、確認は 1 回にまとめる。
    if (confirmingSessionRef.current) return
    confirmingSessionRef.current = true
    try {
      // session が有効なら画面はそのまま残す。User を入れ直すと画面全体が描き直され、
      // 同じ API を呼び直して 401 を繰り返すおそれがある。
      if (await fetchCurrentUser()) return
      applyCurrentUser(null)
    } catch {
      // /api/auth/me にも届かないときは session の状態が分からないので、画面を残す。
    } finally {
      confirmingSessionRef.current = false
    }
  }, [applyCurrentUser])

  // ログイン中だけ 401 を受け取る。認証が無効ならログイン画面が無いので受け取らない。
  // ログイン画面の表示中も受け取らない（パスワード誤りの 401 などで確認を繰り返さないため）。
  // 画面が DOM に出た時点で受け取れるよう、layout effect で張る。通常の effect は DOM に
  // 出たあと（子の画面の effect のあと）に走るので、その間に届いた 401 を取りこぼす。
  const signedIn = session.user !== null
  useLayoutEffect(() => {
    if (disabled || !signedIn) return
    return subscribeUnauthorized(() => { void confirmSessionAfterUnauthorized() })
  }, [disabled, signedIn, confirmSessionAfterUnauthorized])

  // session が切れて画面を残している間は、このタブへ戻ってきたときに session を確かめ直す。
  // SSO は新しいタブでログインする（LoginPage の overlay）ので、済ませて戻るだけで画面に戻れる。
  // ログイン画面が見えた時点で受け取れるよう、これも layout effect で張る。
  const keepingExpiredScreen = session.user === null && session.screenUser !== null
  useLayoutEffect(() => {
    if (!keepingExpiredScreen) return
    // /api/auth/me に届かないときは、ログイン画面を重ねたまま待つ。
    const recheck = () => { void reload().catch(() => {}) }
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [keepingExpiredScreen, reload])

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
    const body = await response.json().catch(() => null) as {
      logoutUrl?: string | null
      idpLogoutUnavailable?: boolean
    } | null
    logoutLocally({ idpLogoutUnavailable: body?.idpLogoutUnavailable === true })
    if (body?.logoutUrl) window.location.assign(body.logoutUrl)
  }, [logoutLocally])
  // 画面には、描いている User を渡す。session が切れてログイン画面を重ねている間も、
  // 残した画面は同じ User のまま描く。
  const screenUser = session.screenUser
  const value = useMemo(() => ({ enabled: !disabled, user: screenUser, logout, reload }), [disabled, screenUser, logout, reload])

  if (loading) return <div className="auth-splash" role="status">読み込み中…</div>
  if (error) return <div className="auth-splash error" role="alert">{error}</div>
  const authPage = !disabled && config ? authPageFor({ config, session, onSessionChanged: reload }) : null
  // 残す画面が無ければ（起動時やサインアウトのあと）、ログイン画面だけを出す。
  if (authPage && !screenUser) return authPage
  return (
    <AuthContext.Provider value={value}>
      {/* key: 別の User で入り直したら、前の User の画面（書きかけの本文など）を作り直す。 */}
      <div key={screenUser?.id} inert={authPage !== null}>{children}</div>
      {authPage && (
        // key: ログイン画面とパスワード変更画面を切り替えたら、focus を移し直す。
        <AuthOverlay key={session.user ? 'change-password' : 'login'} titleId={AUTH_TITLE_ID}>
          {authPage}
        </AuthOverlay>
      )}
    </AuthContext.Provider>
  )
}
