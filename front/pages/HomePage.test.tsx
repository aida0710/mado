import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HomePage from './HomePage'

vi.mock('../lib/api/client', () => ({
  api: { note: vi.fn() },
}))

import { api } from '../lib/api/client'

const noteMock = api.note as ReturnType<typeof vi.fn>

afterEach(() => { vi.resetAllMocks() })

function renderHome() {
  return render(<MemoryRouter><HomePage /></MemoryRouter>)
}

describe('HomePage — Team note の取得失敗', () => {
  it('ノートを読み込めないと、「まだ何も書かれていません」や作成の導線を出さず、理由と再試行を出す', async () => {
    noteMock.mockRejectedValue(new Error('Internal Server Error'))
    renderHome()

    expect(await screen.findByRole('alert')).toHaveTextContent('Team noteを読み込めませんでした（Internal Server Error）')
    expect(screen.getByRole('button', { name: '再試行' })).toBeInTheDocument()
    expect(screen.queryByText('まだ何も書かれていません')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /作成|編集|最初のノートを書く/ })).not.toBeInTheDocument()
  })

  it('再試行して読み込めれば、本文と編集の導線を出す', async () => {
    noteMock
      .mockRejectedValueOnce(new Error('Internal Server Error'))
      .mockResolvedValueOnce({ exists: true, body: '# 共有メモ', last_editor: 'aida', last_edited_at: '2026-09-29T01:00:00Z' })
    const user = userEvent.setup()
    renderHome()

    await user.click(await screen.findByRole('button', { name: '再試行' }))

    expect(await screen.findByRole('heading', { name: '共有メモ' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /編集/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('まだ書かれていないときは、これまでどおり作成の導線を出す', async () => {
    noteMock.mockResolvedValue({ exists: false })
    renderHome()

    expect(await screen.findByText('まだ何も書かれていません')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /作成/ })).toBeInTheDocument()
  })
})
