import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import type { LineageLink } from '../lib/api/types'
import { LineageListView } from './LineageListView'

afterEach(() => vi.restoreAllMocks())

const link = (id: number, p: [string, string], c: [string, string]): LineageLink => ({
  id,
  parentBucket: p[0], parentPath: p[1],
  childBucket: c[0], childPath: c[1],
  createdBy: 'someone',
  createdAt: '2026-01-01T00:00:00.000Z',
})

function renderView() {
  return render(
    <MemoryRouter>
      <LineageListView connId="c1" />
    </MemoryRouter>,
  )
}

describe('LineageListView', () => {
  it('件数を出す', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
      link(2, ['clean', 'v2/'], ['out', 'final.csv']),
    ])
    renderView()
    expect(await screen.findByText('2 件')).toBeInTheDocument()
  })

  it('親 → 子 の一覧を出す', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
    ])
    renderView()

    const row = within(await screen.findByRole('list')).getByRole('listitem')
    expect(within(row).getByText('raw/2024-01/')).toBeInTheDocument()
    expect(within(row).getByText('clean/v2/')).toBeInTheDocument()
  })

  // path === '' はバケット自身のノード。バケット名だけを出す。
  it('バケットノードはバケット名だけで表示する', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', ''], ['clean', '']),
    ])
    renderView()

    expect(await screen.findByRole('link', { name: /raw/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /clean/ })).toBeInTheDocument()
    expect(screen.queryByText('raw/')).not.toBeInTheDocument()
  })

  it('ノードはその場所へのリンクになっている', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', ''], ['clean', 'v2/']),
    ])
    renderView()

    expect(await screen.findByRole('link', { name: /raw/ }))
      .toHaveAttribute('href', '/storage/c1/raw/')
    expect(screen.getByRole('link', { name: /clean\/v2\// }))
      .toHaveAttribute('href', '/storage/c1/clean/v2/')
  })

  it('リンクが無ければ空の案内を出す', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([])
    renderView()
    expect(await screen.findByText(/リンクがまだありません/)).toBeInTheDocument()
  })

  it('取得に失敗したらエラーを出す', async () => {
    vi.spyOn(api, 'lineageLinks').mockRejectedValue(new Error('boom'))
    renderView()
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })
})
