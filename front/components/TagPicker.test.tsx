import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../lib/api/client'
import { TagPicker } from './TagPicker'

afterEach(() => vi.restoreAllMocks())

const TAGS = [
  { id: 't1', name: '重要', color: '#ff0000' },
  { id: 't2', name: '未整理', color: '#00ff00' },
]

describe('TagPicker', () => {
  it('割り当て済みタグがチェック済みで表示される', () => {
    render(
      <MemoryRouter>
        <TagPicker
          connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
          allTags={TAGS} assignedTagIds={['t1']}
          onChange={() => {}} onClose={() => {}}
        />
      </MemoryRouter>,
    )
    expect(screen.getByRole('checkbox', { name: '重要' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '未整理' })).not.toBeChecked()
  })

  it('チェックすると assignTag を呼び、onChange で反映する', async () => {
    const assignSpy = vi.spyOn(api, 'assignTag').mockResolvedValue(undefined)
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <TagPicker
          connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
          allTags={TAGS} assignedTagIds={[]}
          onChange={onChange} onClose={() => {}}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '重要' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(assignSpy).toHaveBeenCalledWith('c1', 'bkt', 'file', 'a.txt', 't1')
    expect(onChange).toHaveBeenCalledWith(['t1'])
  })

  it('チェックを外すと unassignTag を呼び、onChange で反映する', async () => {
    const unassignSpy = vi.spyOn(api, 'unassignTag').mockResolvedValue(undefined)
    const onChange = vi.fn()
    render(
      <MemoryRouter>
        <TagPicker
          connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
          allTags={TAGS} assignedTagIds={['t1']}
          onChange={onChange} onClose={() => {}}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '重要' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(unassignSpy).toHaveBeenCalledWith('c1', 'bkt', 'file', 'a.txt', 't1')
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('API が失敗したらチェック状態を戻しエラーを表示する', async () => {
    vi.spyOn(api, 'assignTag').mockRejectedValue(new Error('boom'))
    render(
      <MemoryRouter>
        <TagPicker
          connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
          allTags={TAGS} assignedTagIds={[]}
          onChange={() => {}} onClose={() => {}}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('checkbox', { name: '重要' }))
    expect(await screen.findByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '重要' })).not.toBeChecked()
  })

  it('タグが 0 件なら案内メッセージを出す', () => {
    render(
      <MemoryRouter>
        <TagPicker
          connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
          allTags={[]} assignedTagIds={[]}
          onChange={() => {}} onClose={() => {}}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText(/タグがまだありません/)).toBeInTheDocument()
  })

  it('閉じるボタンで onClose が呼ばれる', () => {
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <TagPicker
          connId="c1" bucket="bkt" kind="file" path="a.txt" label="a.txt"
          allTags={TAGS} assignedTagIds={[]}
          onChange={() => {}} onClose={onClose}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onClose).toHaveBeenCalled()
  })
})
