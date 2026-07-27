import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TagFilterBar } from './TagFilterBar'

const TAGS = [
  { id: 't1', name: '重要', color: '#ff0000' },
  { id: 't2', name: '未整理', color: '#00ff00' },
]

describe('TagFilterBar', () => {
  it('tags が空なら何も描画しない', () => {
    const { container } = render(
      <TagFilterBar tags={[]} selected={new Set()} onToggle={() => {}} onClear={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('候補タグをチップで表示し、クリックで onToggle を呼ぶ', () => {
    const onToggle = vi.fn()
    render(
      <TagFilterBar tags={TAGS} selected={new Set()} onToggle={onToggle} onClear={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '重要' }))
    expect(onToggle).toHaveBeenCalledWith('t1')
  })

  it('選択中は「クリア」ボタンが出る', () => {
    const onClear = vi.fn()
    render(
      <TagFilterBar tags={TAGS} selected={new Set(['t1'])} onToggle={() => {}} onClear={onClear} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'クリア' }))
    expect(onClear).toHaveBeenCalled()
  })
})
