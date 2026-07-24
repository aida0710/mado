import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api/client'
import { EntryTable } from './EntryTable'

const ALL_TAGS = [{ id: 't1', name: '重要', color: '#ff0000' }]

describe('EntryTable タグ', () => {
  it('割り当て済みタグがファイル行にバッジ表示される', () => {
    render(
      <MemoryRouter>
        <EntryTable
          dirs={[]}
          files={[{ key: 'notes.txt', size: 10, lastModified: null }]}
          prefix="" connId="c" bucket="b"
          allTags={ALL_TAGS}
          tagsByPath={{ 'notes.txt': ['t1'] }}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('重要')).toBeInTheDocument()
  })

  it('割り当て済みタグがディレクトリ行にバッジ表示される', () => {
    render(
      <MemoryRouter>
        <EntryTable
          dirs={['sub/']}
          files={[]}
          prefix="" connId="c" bucket="b"
          allTags={ALL_TAGS}
          tagsByPath={{ 'sub/': ['t1'] }}
        />
      </MemoryRouter>,
    )
    expect(screen.getByText('重要')).toBeInTheDocument()
  })

  it('⋯ メニューの「タグを編集」で TagPicker が開き、トグルすると onTagsChange が呼ばれる', async () => {
    vi.spyOn(api, 'assignTag').mockResolvedValue(undefined)
    const onTagsChange = vi.fn()
    render(
      <MemoryRouter>
        <EntryTable
          dirs={[]}
          files={[{ key: 'notes.txt', size: 10, lastModified: null }]}
          prefix="" connId="c" bucket="b"
          allTags={ALL_TAGS}
          tagsByPath={{}}
          onTagsChange={onTagsChange}
        />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'アクション' }))
    fireEvent.click(screen.getByText('タグを編集'))
    fireEvent.click(screen.getByRole('checkbox', { name: '重要' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(onTagsChange).toHaveBeenCalledWith('notes.txt', ['t1'])
  })
})
