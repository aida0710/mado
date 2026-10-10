import { useEffect, useState } from 'react'
import { narrowerThan } from './breakpoints'
import { clampNavigationWidth, NAVIGATION_WIDTH, storedNavigationWidth } from './navigationWidth'
import { useMediaQuery } from './useMediaQuery'

// md (900px) 未満はアイコンの列も置けないのでドロワーに入れる。lg (1200px) 未満は名前つきの
// サイドバーだと一覧の幅が足りないので、アイコンだけの列にする。Mado Model Tracking と同じ。
const DRAWER_QUERY = narrowerThan('md')
const RAIL_QUERY = narrowerThan('lg')
const COLLAPSED_STORAGE_KEY = 'mado.navigation.collapsed'
const WIDTH_STORAGE_KEY = 'mado.navigation.width'

/** sidebar: 名前とアイコン、rail: アイコンだけ、drawer: 上部バーのメニューボタンから開く。 */
export type NavigationMode = 'sidebar' | 'rail' | 'drawer'

export interface Navigation {
  mode: NavigationMode
  /** 広い画面では、名前つきのサイドバーとアイコンだけの列を利用者が切り替えられる。 */
  canCollapse: boolean
  toggleCollapsed: () => void
  width: number
  setWidth: (width: number) => void
  resetWidth: () => void
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 保存できなくても、開いている間は切り替えも幅も効く。 */
  }
}

/** 今の画面幅でのサイドバーの形と、利用者が選んだ幅・畳んだかどうか。 */
export function useNavigation(): Navigation {
  const usesDrawer = useMediaQuery(DRAWER_QUERY)
  const fitsOnlyRail = useMediaQuery(RAIL_QUERY)
  const [collapsed, setCollapsed] = useState(() => readStorage(COLLAPSED_STORAGE_KEY) === 'true')
  const [width, setStoredWidth] = useState(() => storedNavigationWidth(readStorage(WIDTH_STORAGE_KEY)))
  useEffect(() => writeStorage(COLLAPSED_STORAGE_KEY, String(collapsed)), [collapsed])
  useEffect(() => writeStorage(WIDTH_STORAGE_KEY, String(width)), [width])
  const mode: NavigationMode = usesDrawer ? 'drawer' : fitsOnlyRail || collapsed ? 'rail' : 'sidebar'
  return {
    mode,
    canCollapse: !usesDrawer && !fitsOnlyRail,
    toggleCollapsed: () => setCollapsed(current => !current),
    width,
    setWidth: next => setStoredWidth(clampNavigationWidth(next)),
    resetWidth: () => setStoredWidth(NAVIGATION_WIDTH.default),
  }
}
