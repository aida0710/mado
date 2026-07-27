import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TagBadge } from './TagBadge'

describe('TagBadge', () => {
  it('タグ名を表示する', () => {
    render(<TagBadge tag={{ name: '重要', color: '#ff0000' }} />)
    expect(screen.getByText('重要')).toBeInTheDocument()
  })

  it('背景色に tag.color を使う', () => {
    render(<TagBadge tag={{ name: 'A', color: '#ff0000' }} />)
    const el = screen.getByText('A')
    expect(el.style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('暗い背景では白文字、明るい背景では黒文字になる', () => {
    render(
      <>
        <TagBadge tag={{ name: 'dark', color: '#000000' }} />
        <TagBadge tag={{ name: 'light', color: '#ffffff' }} />
      </>,
    )
    expect(screen.getByText('dark').style.color).toBe('rgb(255, 255, 255)')
    expect(screen.getByText('light').style.color).toBe('rgb(0, 0, 0)')
  })
})
