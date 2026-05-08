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
  // mockResolvedValueOnce のキューを完全に空にするため reset (clear だけだと残る)。
  // 残ったキューが次のテストで誤消費されると、見かけ上関係ないテストが落ちる。
  ;(api.list as ReturnType<typeof vi.fn>).mockReset()
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
      nextStartAfter: null,
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
      nextStartAfter: null,
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

    // 進捗バー要素 + ARIA progressbar role が出る
    expect(screen.getByRole('progressbar', { name: '読み込み中' })).toBeInTheDocument()

    // 古い内容も dim 状態で残っている (link はまだ存在する)
    expect(screen.queryByRole('link', { name: /jp\// })).toBeInTheDocument()

    // 解決すれば消える
    resolveSecond({ directories: [], files: [], nextContinuation: null, nextStartAfter: null })
    await waitFor(() =>
      expect(screen.queryByRole('progressbar')).toBeNull()
    )
  })

  it('issues api.list with prefix + query when user searches in current directory', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    // 1 回目 (初回 mount): prefix='voice/', q=''
    listMock.mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })
    // 2 回目 (検索後): prefix='voice/' + 'j' で再 fetch
    listMock.mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderBrowser('voice/')
    await screen.findByRole('link', { name: /jp\// })
    expect(listMock).toHaveBeenCalledTimes(1)
    // 初回呼び出しの prefix は 'voice/'、再帰オフ
    expect(listMock.mock.calls[0]).toEqual(['c1', 'b1', 'voice/', {}, { recursive: false }])

    // 検索 input に 'j' を入力 → debounce 後に 2 回目の list が走る
    await user.type(screen.getByLabelText('ディレクトリ内検索'), 'j')
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2), { timeout: 1000 })
    // 2 回目の prefix は 'voice/' + 'j' = 'voice/j'
    expect(listMock.mock.calls[1]).toEqual(['c1', 'b1', 'voice/j', {}, { recursive: false }])
  })

  it('passes recursive=true to api.list when the recursive checkbox is toggled', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    listMock.mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/jp/a.wav', size: 1, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderBrowser('voice/')
    await screen.findByRole('link', { name: /jp\// })
    expect(listMock.mock.calls[0]).toEqual(['c1', 'b1', 'voice/', {}, { recursive: false }])

    // 再帰チェックを ON → 同じ prefix で recursive: true で再 fetch
    await user.click(screen.getByLabelText('再帰検索'))
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    expect(listMock.mock.calls[1]).toEqual(['c1', 'b1', 'voice/', {}, { recursive: true }])
  })

  it('enables the "次" pager button when the response carries a next cursor', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/a.mp3', size: 1, lastModified: null }],
      nextContinuation: 'tok1',
      nextStartAfter: null,
    })

    renderBrowser('voice/')
    await screen.findByText(/a\.mp3/)

    // 応答に nextContinuation があれば「次 →」ボタンが活きる。
    // 1 ページ目なので「戻る」は disabled、「次」は enabled。
    const nextBtn = screen.getByRole('button', { name: '次のページへ' })
    expect(nextBtn).toBeEnabled()
    const prevBtn = screen.getByRole('button', { name: '前のページへ' })
    expect(prevBtn).toBeDisabled()
  })

  it('advances to page 2 when the user clicks "次 →" and uses the next cursor', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    // 1 ページ目: nextContinuation='tok1' で次があることを示す
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/a.mp3', size: 1, lastModified: null }],
      nextContinuation: 'tok1',
      nextStartAfter: null,
    })
    // 2 ページ目: 末尾 (next なし)
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/b.mp3', size: 2, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderBrowser('voice/')
    await screen.findByText(/a\.mp3/)
    expect(listMock).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '次のページへ' }))

    // 2 回目の list は cursor: { continuation: 'tok1' } で呼ばれる。
    // forward navigation なので force:true で cache を bypass する
    // (DDN/MDX 互換 S3 で cursor が進まない問題への防衛)。
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    expect(listMock.mock.calls[1]).toEqual([
      'c1', 'b1', 'voice/', { continuation: 'tok1' }, { recursive: false, force: true },
    ])

    // 表示が page 2 の中身 (b.mp3) に置き換わる
    await screen.findByText(/b\.mp3/)
    // page 2 では next が disabled (nextContinuation=null)、戻るは enabled
    expect(screen.getByRole('button', { name: '次のページへ' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '前のページへ' })).toBeEnabled()
  })

  it('advances through multiple pages: page 1 → 2 → 3 each with distinct cursor', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    // 3 ページ分用意。各 nextContinuation は別物。
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/p1.mp3', size: 1, lastModified: null }],
      nextContinuation: 'tok-after-p1',
      nextStartAfter: null,
    })
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/p2.mp3', size: 2, lastModified: null }],
      nextContinuation: 'tok-after-p2',
      nextStartAfter: null,
    })
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/p3.mp3', size: 3, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderBrowser('voice/')
    await screen.findByText(/p1\.mp3/)
    expect(listMock.mock.calls[0]).toEqual(['c1', 'b1', 'voice/', {}, { recursive: false }])

    // p1 → p2: cursor は p1 が返した tok-after-p1。forward navigation は force:true。
    await user.click(screen.getByRole('button', { name: '次のページへ' }))
    await screen.findByText(/p2\.mp3/)
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(listMock.mock.calls[1]).toEqual([
      'c1', 'b1', 'voice/', { continuation: 'tok-after-p1' }, { recursive: false, force: true },
    ])
    // p1 の表示は消えている
    expect(screen.queryByText(/p1\.mp3/)).toBeNull()

    // p2 → p3: cursor は p2 が返した tok-after-p2
    await user.click(screen.getByRole('button', { name: '次のページへ' }))
    await screen.findByText(/p3\.mp3/)
    expect(listMock).toHaveBeenCalledTimes(3)
    expect(listMock.mock.calls[2]).toEqual([
      'c1', 'b1', 'voice/', { continuation: 'tok-after-p2' }, { recursive: false, force: true },
    ])
    expect(screen.queryByText(/p2\.mp3/)).toBeNull()
  })

  it('uses the DDN startAfter fallback when the response carries no continuation token', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    // DDN/MDX 互換 S3 は IsTruncated=true でも nextContinuation を返さないことがあり、
    // backend は最終キーを nextStartAfter にフォールバックさせる。
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/p1.mp3', size: 1, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: 'voice/p1.mp3',
    })
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/p2.mp3', size: 2, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderBrowser('voice/')
    await screen.findByText(/p1\.mp3/)

    // 「次」を押すと cursor: { startAfter: '...' } で fetch される。
    // forward navigation なので force:true がつく。
    await user.click(screen.getByRole('button', { name: '次のページへ' }))
    await screen.findByText(/p2\.mp3/)
    expect(listMock.mock.calls[1]).toEqual([
      'c1', 'b1', 'voice/', { startAfter: 'voice/p1.mp3' }, { recursive: false, force: true },
    ])
  })

  it('disables 次 when the server returns a cursor identical to the one used to fetch the current page (stuck pagination)', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    // 1 ページ目: nextContinuation='STUCK'
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/p1.mp3', size: 1, lastModified: null }],
      nextContinuation: 'STUCK',
      nextStartAfter: null,
    })
    // 2 ページ目: cursor='STUCK' で取りに行ったあと、server が同じ 'STUCK' を返してきた
    // (DDN/MDX 系の S3 互換でしばしば見られるバグ)。ここで「次」を押せても
    // 同じ cursor で再 fetch するだけなので末尾扱いに落としたい。
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'voice/p2.mp3', size: 2, lastModified: null }],
      nextContinuation: 'STUCK',
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderBrowser('voice/')
    await screen.findByText(/p1\.mp3/)

    // 1 ページ目: hasNext=true (まだ STUCK で fetch していない)
    expect(screen.getByRole('button', { name: '次のページへ' })).toBeEnabled()

    // 1 → 2 は forward: cache を bypass して必ずネット fetch する (force:true)
    await user.click(screen.getByRole('button', { name: '次のページへ' }))
    await screen.findByText(/p2\.mp3/)
    expect(listMock).toHaveBeenCalledTimes(2)
    // page 2 の fetch は force:true で呼ばれている
    expect(listMock.mock.calls[1]).toEqual([
      'c1', 'b1', 'voice/', { continuation: 'STUCK' }, { recursive: false, force: true },
    ])

    // page 2 で nextContinuation=STUCK が再来 → cursor が進まない → 「次」disable
    expect(screen.getByRole('button', { name: '次のページへ' })).toBeDisabled()
    // 案内文も出る
    expect(screen.getByText(/cursor を進めずに同じトークン/)).toBeInTheDocument()
  })

  it('shows a copy menu on directory row with Web URL and S3 URL items', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: ['voice/jp/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
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
