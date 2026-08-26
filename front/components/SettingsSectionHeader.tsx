import type { ReactNode } from 'react'

const titleClass =
  'm-0 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-ink-7'

interface SettingsSectionHeaderProps {
  title: string
  actions?: ReactNode
}

export function SettingsSectionHeader({ title, actions }: SettingsSectionHeaderProps) {
  return (
    <header
      className="mb-3 flex flex-wrap items-baseline justify-between gap-3 pb-2"
      style={{ borderBottom: '1px solid var(--rule)' }}
    >
      <h3 className={titleClass}>{title}</h3>
      {actions}
    </header>
  )
}
