import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TagBadge } from './TagBadge'

describe('TagBadge', () => {
  it('タグ名を表示する', () => {
    render(<TagBadge tag={{ name: '重要', color: '#ff0000' }} />)
    expect(screen.getByText('重要')).toBeInTheDocument()
  })

  // 色は面と罫に薄く乗せるだけ。ベタ塗りに戻すと彩度の高いユーザー指定色が
  // インク調の UI の中で主役になってしまう。
  it('色は面 12% / 罫 32% に薄めて使う', () => {
    render(<TagBadge tag={{ name: 'A', color: '#ff0000' }} />)
    const el = screen.getByText('A')
    expect(el.style.backgroundColor).toBe('color-mix(in srgb, #ff0000 12%, var(--paper))')
    expect(el.style.border).toBe('1px solid color-mix(in srgb, #ff0000 32%, var(--rule))')
  })

  // 文字色はインクに固定。背景が薄いので明暗の出し分けは要らない。
  it('文字色はタグの色に依存しない', () => {
    render(
      <>
        <TagBadge tag={{ name: 'dark', color: '#000000' }} />
        <TagBadge tag={{ name: 'light', color: '#ffffff' }} />
      </>,
    )
    for (const name of ['dark', 'light']) {
      const el = screen.getByText(name)
      expect(el.style.color).toBe('')
      expect(el.className).toContain('text-ink-11')
    }
  })
})
