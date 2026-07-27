import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import { StorageBrowser } from './StorageBrowser'

afterEach(() => vi.restoreAllMocks())

describe('StorageBrowser タグ', () => {
  it('一覧取得後にタグをバッチ取得してバッジ表示する', async () => {
    vi.spyOn(api, 'list').mockResolvedValue({
      directories: [], files: [{ key: 'a.txt', size: 1, lastModified: null }],
      nextContinuation: null, nextStartAfter: null,
    })
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    vi.spyOn(api, 'tagAssignments').mockImplementation(async (_c, _b, kind): Promise<Record<string, string[]>> =>
      kind === 'file' ? { 'a.txt': ['t1'] } : {})
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    render(
      <MemoryRouter>
        <StorageBrowser connId="c1" bucket="bkt" prefix="" />
      </MemoryRouter>,
    )
    // 「重要」は TagFilterBar の候補チップと EntryTable の行バッジの両方に
    // 出現するため、findByText (単数) だと "Found multiple elements" になる。
    // ここでは「少なくとも 1 箇所にバッジ表示されている」ことだけを確認する。
    const badges = await screen.findAllByText('重要')
    expect(badges.length).toBeGreaterThan(0)
  })

  it('タグチップを選ぶと一致しない行が隠れる', async () => {
    vi.spyOn(api, 'list').mockResolvedValue({
      directories: [],
      files: [
        { key: 'a.txt', size: 1, lastModified: null },
        { key: 'b.txt', size: 1, lastModified: null },
      ],
      nextContinuation: null, nextStartAfter: null,
    })
    vi.spyOn(api, 'tags').mockResolvedValue([{ id: 't1', name: '重要', color: '#ff0000' }])
    vi.spyOn(api, 'tagAssignments').mockImplementation(async (_c, _b, kind): Promise<Record<string, string[]>> =>
      kind === 'file' ? { 'a.txt': ['t1'] } : {})
    vi.spyOn(api, 'lastFetched', 'get').mockReturnValue({
      list: () => null, readme: () => null, tar: () => null, buckets: () => null,
    })

    render(
      <MemoryRouter>
        <StorageBrowser connId="c1" bucket="bkt" prefix="" />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('a.txt')).toBeInTheDocument())
    expect(screen.getByText('b.txt')).toBeInTheDocument()

    const { fireEvent } = await import('@testing-library/react')
    fireEvent.click(screen.getByRole('button', { name: '重要' }))

    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.queryByText('b.txt')).not.toBeInTheDocument()
  })
})
