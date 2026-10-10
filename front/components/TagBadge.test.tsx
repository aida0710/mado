import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TagBadge } from './TagBadge'

describe('TagBadge', () => {
  it('タグ名を表示する', () => {
    render(<TagBadge tag={{ name: '重要', color: '#ff0000' }} />)
    expect(screen.getByText('重要')).toBeInTheDocument()
  })

  // 色は名前の前の点にだけ使う。地に塗ると彩度の高いユーザー指定色が
  // 一覧の中で主役になってしまう。
  it('色は名前の前の点にだけ使う', () => {
    render(<TagBadge tag={{ name: 'A', color: '#ff0000' }} />)
    const el = screen.getByText('A')
    expect(el.style.backgroundColor).toBe('')
    const dot = el.querySelector<HTMLElement>('[aria-hidden="true"]')
    expect(dot?.style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  // 地と文字は共通のラベル (.status-badge) の色に固定する。明暗の出し分けは要らない。
  it('地と文字の色はタグの色に依存しない', () => {
    render(
      <>
        <TagBadge tag={{ name: 'dark', color: '#000000' }} />
        <TagBadge tag={{ name: 'light', color: '#ffffff' }} />
      </>,
    )
    const [dark, light] = ['dark', 'light'].map(name => screen.getByText(name))
    for (const el of [dark, light]) {
      expect(el.style.color).toBe('')
      expect(el.style.backgroundColor).toBe('')
      expect(el.className).toContain('status-badge')
    }
    expect(dark.className).toBe(light.className)
  })
})
