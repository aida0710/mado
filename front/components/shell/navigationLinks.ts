import { HardDrive, House, Network, Settings, type LucideIcon } from 'lucide-react'

export interface NavigationLink {
  to: string
  label: string
  icon: LucideIcon
}

/** 左のサイドバー (狭い画面ではドロワー) に並べる画面。 */
export const NAVIGATION_LINKS: readonly NavigationLink[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/storage', label: 'Storage', icon: HardDrive },
  { to: '/lineage', label: 'DataLineage', icon: Network },
  { to: '/settings', label: 'Settings', icon: Settings },
]

/** 今の画面がこのリンクの配下か。Home は / のときだけ。 */
export function isCurrentLink(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/' || pathname === '/edit-note'
  return pathname === to || pathname.startsWith(`${to}/`)
}
