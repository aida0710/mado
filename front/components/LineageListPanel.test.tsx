import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import type { LineageLink } from '../lib/api/types'
import { LineageListPanel } from './LineageListPanel'

afterEach(() => vi.restoreAllMocks())

const link = (id: number, p: [string, string], c: [string, string]): LineageLink => ({
  id,
  parentBucket: p[0], parentPath: p[1],
  childBucket: c[0], childPath: c[1],
  createdBy: 'someone',
  createdAt: '2026-01-01T00:00:00.000Z',
})

function renderPanel() {
  return render(
    <MemoryRouter>
      <LineageListPanel connId="c1" />
    </MemoryRouter>,
  )
}

describe('LineageListPanel', () => {
  it('既定では畳んでおり、件数だけをラベルに出す', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
      link(2, ['clean', 'v2/'], ['out', 'final.csv']),
    ])
    renderPanel()

    const head = await screen.findByRole('button', { name: /家系図/ })
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveTextContent('(2)')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('開くと 親 → 子 の一覧を出す', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
    ])
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /家系図/ }))
    const row = within(screen.getByRole('list')).getByRole('listitem')
    expect(within(row).getByText('raw/2024-01/')).toBeInTheDocument()
    expect(within(row).getByText('clean/v2/')).toBeInTheDocument()
  })

  // path === '' はバケット自身のノード。バケット名だけを出す。
  it('バケットノードはバケット名だけで表示する', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', ''], ['clean', '']),
    ])
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /家系図/ }))
    expect(screen.getByRole('link', { name: /raw/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /clean/ })).toBeInTheDocument()
    expect(screen.queryByText('raw/')).not.toBeInTheDocument()
  })

  it('ノードはその場所へのリンクになっている', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', ''], ['clean', 'v2/']),
    ])
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /家系図/ }))
    expect(screen.getByRole('link', { name: /raw/ })).toHaveAttribute('href', '/storage/c1/raw/')
    expect(screen.getByRole('link', { name: /clean\/v2\// }))
      .toHaveAttribute('href', '/storage/c1/clean/v2/')
  })

  it('リンクが無ければ空の案内を出す', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([])
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /家系図/ }))
    expect(screen.getByText(/リンクがまだありません/)).toBeInTheDocument()
  })

  it('取得に失敗したらエラーを出す', async () => {
    const user = userEvent.setup()
    vi.spyOn(api, 'lineageLinks').mockRejectedValue(new Error('boom'))
    renderPanel()

    await user.click(await screen.findByRole('button', { name: /家系図/ }))
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })
})
