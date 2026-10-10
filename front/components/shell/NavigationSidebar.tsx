import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { Navigation } from '../../lib/useNavigation'
import { NavigationLinkList } from './NavigationLinkList'
import { NavigationResizeHandle } from './NavigationResizeHandle'

/**
 * md (900px) 以上の画面の切り替え。名前つきのサイドバーか、lg (1200px) 未満または利用者が
 * 畳んだときはアイコンだけの列。広い画面では下のボタンで畳んだり広げたりでき、右の境目を
 * ドラッグして幅を変えられる。狭い画面では NavigationDrawer を使う。
 */
export function NavigationSidebar({ navigation }: { navigation: Navigation }) {
  const isRail = navigation.mode === 'rail'
  const toggleLabel = isRail ? 'サイドバーを広げる' : 'サイドバーをアイコンだけにする'
  return (
    <aside className="navigation-sidebar" data-collapsed={isRail ? 'true' : 'false'}>
      <div className="navigation-sidebar-scroll">
        <NavigationLinkList showsTitles={isRail} />
      </div>
      {navigation.canCollapse && (
        <div className="navigation-sidebar-footer">
          <button
            type="button"
            className="icon-button"
            aria-label={toggleLabel}
            aria-expanded={!isRail}
            title={toggleLabel}
            onClick={navigation.toggleCollapsed}
          >
            {isRail ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
      )}
      {navigation.canCollapse && !isRail && (
        <NavigationResizeHandle
          width={navigation.width}
          onResize={navigation.setWidth}
          onReset={navigation.resetWidth}
        />
      )}
    </aside>
  )
}
