import { useState } from 'react'
import { Link } from 'react-router-dom'
import { LogOut, Moon, Sun } from 'lucide-react'
import { useAuth } from '../../lib/auth-context'
import { initials } from '../../lib/initials'
import type { Navigation } from '../../lib/useNavigation'
import { useTheme } from '../../lib/useTheme'
import { NavigationDrawer } from './NavigationDrawer'

/**
 * 上部バー: アプリ名、テーマの切り替え、ログイン中の利用者とサインアウト。画面の切り替えは
 * サイドバーにあり、md (900px) 未満ではこのバーのメニューボタンからドロワーで開く。
 */
export function TopBar({ navigation }: { navigation: Navigation }) {
  const { enabled, user, logout } = useAuth()
  const theme = useTheme()
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const themeLabel = theme.theme === 'light' ? 'ダークテーマにする' : 'ライトテーマにする'
  const signOut = async () => {
    setLoggingOut(true)
    setLogoutError(null)
    try {
      await logout()
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : 'サインアウトできませんでした')
    } finally {
      setLoggingOut(false)
    }
  }
  return (
    <>
      <a className="skip-link" href="#content">本文へ移動</a>
      <header className="topbar">
        {navigation.mode === 'drawer' && <NavigationDrawer />}
        <Link to="/" className="brand" aria-label="Mado ホームへ">Mado</Link>
        <div className="topbar-actions">
          <button
            type="button"
            className="icon-button"
            onClick={theme.toggle}
            aria-label={themeLabel}
            title={themeLabel}
          >
            {theme.theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          {enabled && user && (
            <>
              <Link
                to="/settings/account"
                className="avatar"
                aria-label={`${user.displayName} のアカウント`}
                title={user.displayName}
              >
                {initials(user.displayName)}
              </Link>
              <button
                type="button"
                className="icon-button"
                aria-label="サインアウト"
                title="サインアウト"
                disabled={loggingOut}
                onClick={() => void signOut()}
              >
                <LogOut size={17} />
              </button>
            </>
          )}
        </div>
      </header>
      {logoutError && <p className="notice error topbar-notice" role="alert">{logoutError}</p>}
    </>
  )
}
