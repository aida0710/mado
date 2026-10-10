import type { ReactNode } from 'react'

interface SettingsSectionHeaderProps {
  title: string
  actions?: ReactNode
}

/** 設定の各タブの区切りの見出し。右に一覧の操作 (追加・エクスポートなど) を並べる。 */
export function SettingsSectionHeader({ title, actions }: SettingsSectionHeaderProps) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {actions && <div>{actions}</div>}
    </div>
  )
}
