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

  it('shows a progress bar while a re-list is in flight (prefix change)', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    // 1 回目 (初回 mount): 即解決
    listMock.mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
    })
    // 2 回目 (prefix 変更後): 手動で resolve するまで pending
    let resolveSecond: (v: unknown) => void = () => {}
    listMock.mockReturnValueOnce(
      new Promise(res => { resolveSecond = res }),
    )

    const { rerender } = render(
      <MemoryRouter>
        <StorageBrowser connId="c1" bucket="b1" prefix="voice/" />
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: /jp\// })

    // prefix を変えると useEffect が走り 2 回目の load が始まる
    rerender(
      <MemoryRouter>
        <StorageBrowser connId="c1" bucket="b1" prefix="other/" />
      </MemoryRouter>,
    )

    // 2 回目が in-flight: api.list が 2 回呼ばれている
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))

    // 進捗バー要素が出る
    expect(document.querySelector('.storage-progress')).not.toBeNull()

    // 古い内容も dim 状態で残っている (link はまだ存在する)
    expect(screen.queryByRole('link', { name: /jp\// })).toBeInTheDocument()

    // 解決すれば消える
    resolveSecond({ directories: [], files: [], nextContinuation: null })
    await waitFor(() => expect(document.querySelector('.storage-progress')).toBeNull())
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
