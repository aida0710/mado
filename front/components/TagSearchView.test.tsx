import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import type { Tag } from '../lib/api/types'
import { TagSearchView } from './TagSearchView'

afterEach(() => vi.restoreAllMocks())

const tags: Tag[] = [
  { id: 't1', name: '処理前', color: '#00ff00' },
  { id: 't2', name: '完了', color: '#0000ff' },
]

function renderView() {
  return render(
    <MemoryRouter>
      <TagSearchView connId="c1" />
    </MemoryRouter>,
  )
}

describe('TagSearchView', () => {
  it('全タグをチップとして出す', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()

    expect(await screen.findByRole('button', { name: '処理前' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '完了' })).toBeInTheDocument()
  })

  it('選択が無いうちは検索せず、案内を出す', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    const spy = vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()

    expect(await screen.findByText(/タグを選ぶと/)).toBeInTheDocument()
    await waitFor(() => expect(spy).not.toHaveBeenCalled())
  })

  it('チップを選ぶと接続全体を検索してヒットを出す', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([
      { tagId: 't1', bucket: 'bkt', kind: 'prefix', path: 'a/b/' },
      { tagId: 't1', bucket: 'bkt2', kind: 'bucket', path: '' },
    ])
    renderView()

    await user.click(await screen.findByRole('button', { name: '処理前' }))

    expect(await screen.findByText('2 件')).toBeInTheDocument()
    const list = screen.getByRole('list')
    expect(within(list).getByText('a/b/')).toBeInTheDocument()
    expect(within(list).getByText('(bucket root)')).toBeInTheDocument()
    // 種別が分かるようにラベルを添える。
    expect(within(list).getByText('ディレクトリ')).toBeInTheDocument()
    expect(within(list).getByText('バケット')).toBeInTheDocument()
  })

  it('クリアで選択を解除する', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'tags').mockResolvedValue(tags)
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()

    await user.click(await screen.findByRole('button', { name: '処理前' }))
    await user.click(await screen.findByRole('button', { name: 'クリア' }))
    expect(await screen.findByText(/タグを選ぶと/)).toBeInTheDocument()
  })

  it('タグが 1 つも無ければ Settings へ誘導する', async () => {
    vi.spyOn(api, 'tags').mockResolvedValue([])
    vi.spyOn(api, 'tagSearch').mockResolvedValue([])
    renderView()

    expect(await screen.findByText(/タグがまだありません/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
  })
})
