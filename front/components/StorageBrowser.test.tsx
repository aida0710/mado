import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageBrowser } from './StorageBrowser'

vi.mock('../lib/api/client', () => ({
  api: {
    list: vi.fn(),
    invalidateList: vi.fn(),
    downloadUrl: vi.fn(() => 'http://x/dl'),
  },
}))

import { api } from '../lib/api/client'

afterEach(() => {
  vi.clearAllMocks()
})

function renderBrowser(prefix = 'voice/') {
  return render(
    <MemoryRouter>
      <StorageBrowser connId="c1" bucket="b1" prefix={prefix} />
    </MemoryRouter>,
  )
}

describe('StorageBrowser - directory row', () => {
  it('renders directory name inside an <a href> for native cmd+click support', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
    })

    renderBrowser('voice/')

    const link = await screen.findByRole('link', { name: /jp\// })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/storage/c1/b1/voice/jp/')
  })

  it('shows a copy menu on directory row with Web URL and S3 URL items', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
    })

    const user = userEvent.setup()
    renderBrowser('voice/')
    await screen.findByRole('link', { name: /jp\// })

    // 行は 1 件 (dir のみ)。CopyMenu の trigger ボタンを開く
    await user.click(screen.getByRole('button', { name: 'アクション' }))

    // Web URL 項目 (jsdom の origin は http://localhost なので
    // dirWebUrl は http://localhost/storage/... になる)
    expect(screen.getByRole('menuitem', { name: /Web URL をコピー/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /S3 URL をコピー/ })).toBeInTheDocument()

    // S3 URL の値が trailing slash 入りで s3://b1/voice/jp/ になっていること
    // (CopyMenu は item の value を title 属性 + 小さなプレビュー文字列に出す)
    const s3Item = screen.getByRole('menuitem', { name: /S3 URL をコピー/ })
    expect(s3Item).toHaveAttribute('title', 's3://b1/voice/jp/')
  })
})
