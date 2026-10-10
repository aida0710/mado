import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { Navigation } from '../../lib/useNavigation'
import { NAVIGATION_WIDTH } from '../../lib/navigationWidth'
import { NavigationSidebar } from './NavigationSidebar'
import { isCurrentLink } from './navigationLinks'
import { initials } from '../../lib/initials'

function navigation(overrides: Partial<Navigation> = {}): Navigation {
  return {
    mode: 'sidebar',
    canCollapse: true,
    toggleCollapsed: vi.fn(),
    width: NAVIGATION_WIDTH.default,
    setWidth: vi.fn(),
    resetWidth: vi.fn(),
    ...overrides,
  }
}

function renderSidebar(value: Navigation, path = '/storage/demo/bucket/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NavigationSidebar navigation={value} />
    </MemoryRouter>,
  )
}

describe('NavigationSidebar', () => {
  it('名前つきのサイドバーは、今の画面のリンクに印を付け、畳むボタンと幅を変える境目を出す', () => {
    const value = navigation()
    renderSidebar(value)
    expect(screen.getByRole('link', { name: 'Storage' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
    fireEvent.click(screen.getByRole('button', { name: 'サイドバーをアイコンだけにする' }))
    expect(value.toggleCollapsed).toHaveBeenCalledOnce()
    const handle = screen.getByRole('separator', { name: 'サイドバーの幅' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(value.setWidth).toHaveBeenCalledWith(NAVIGATION_WIDTH.default + NAVIGATION_WIDTH.keyboardStep)
    fireEvent.keyDown(handle, { key: 'Enter' })
    expect(value.resetWidth).toHaveBeenCalledOnce()
  })

  it('アイコンだけの列では名前をツールチップにし、幅は変えられない', () => {
    renderSidebar(navigation({ mode: 'rail' }))
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('title', 'Settings')
    expect(screen.getByRole('button', { name: 'サイドバーを広げる' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('幅でアイコンだけになっているときは、広げるボタンも出さない', () => {
    renderSidebar(navigation({ mode: 'rail', canCollapse: false }))
    expect(screen.queryByRole('button', { name: 'サイドバーを広げる' })).toBeNull()
  })
})

describe('isCurrentLink', () => {
  it('Home はホームとノートの編集のときだけ、ほかは配下の画面でも選択中にする', () => {
    expect(isCurrentLink('/', '/')).toBe(true)
    expect(isCurrentLink('/', '/edit-note')).toBe(true)
    expect(isCurrentLink('/', '/storage')).toBe(false)
    expect(isCurrentLink('/storage', '/storage/demo/bucket/')).toBe(true)
    expect(isCurrentLink('/settings', '/settings-old')).toBe(false)
  })
})

describe('initials', () => {
  it('二語以上なら頭文字を二つ、一語なら先頭の二文字を大文字で返す', () => {
    expect(initials('Sample team')).toBe('ST')
    expect(initials('aida')).toBe('AI')
    expect(initials('相田 太郎')).toBe('相太')
    expect(initials('  ')).toBe('')
  })
})
