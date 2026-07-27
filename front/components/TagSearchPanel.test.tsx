import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { TagSearchPanel } from './TagSearchPanel'

afterEach(() => vi.restoreAllMocks())

describe('TagSearchPanel', () => {
  it('タグを選ぶと接続内横断検索を実行し、結果へのリンクを表示する', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    vi.spyOn(api, 'tagSearch').mockResolvedValue([
      { tagId: 't1', bucket: 'bkt-1', kind: 'bucket', path: '' },
      { tagId: 't1', bucket: 'bkt-2', kind: 'prefix', path: 'dir/' },
      { tagId: 't1', bucket: 'bkt-2', kind: 'file', path: 'dir/file.txt' },
    ])

    render(<MemoryRouter><TagSearchPanel connId="c1" /></MemoryRouter>)
    const chip = await screen.findByRole('button', { name: '重要' })
    fireEvent.click(chip)

    await waitFor(() => expect(screen.getByText('bkt-1')).toBeInTheDocument())
    // bkt-2 は prefix ヒットと file ヒットの 2 行に登場するため singular な
    // getByText では "Found multiple elements" になる。両方描画されていることを
    // 確認する getAllByText に変更 (brief の Step 1 記載テストの欠陥修正、詳細は報告書参照)。
    expect(screen.getAllByText('bkt-2')).toHaveLength(2)
    expect(screen.getByText('dir/')).toBeInTheDocument()
    expect(screen.getByText('dir/file.txt')).toBeInTheDocument()

    const bucketLink = screen.getByText('bkt-1').closest('a')
    expect(bucketLink).toHaveAttribute('href', '/storage/c1/bkt-1/')
  })

  it('タグ未選択なら検索は走らない', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    const searchSpy = vi.spyOn(api, 'tagSearch')
    render(<MemoryRouter><TagSearchPanel connId="c1" /></MemoryRouter>)
    await screen.findByRole('button', { name: '重要' })
    expect(searchSpy).not.toHaveBeenCalled()
  })
})
