import { Link, useLocation } from 'react-router-dom'
import { isCurrentLink, NAVIGATION_LINKS } from './navigationLinks'

/**
 * 画面の切り替えのリンク。サイドバー・アイコンだけの列・ドロワーで共通。
 * アイコンだけの列は名前を画面に出さないので、ツールチップ (title) で示す。
 */
export function NavigationLinkList({ showsTitles = false }: { showsTitles?: boolean }) {
  const { pathname } = useLocation()
  return (
    <nav aria-label="メインナビゲーション">
      <div className="navigation-group">
        {NAVIGATION_LINKS.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="navigation-link"
            aria-current={isCurrentLink(to, pathname) ? 'page' : undefined}
            title={showsTitles ? label : undefined}
          >
            <Icon aria-hidden="true" />
            <span className="navigation-label">{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  )
}
