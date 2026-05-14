import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsertableFileList } from './InsertableFileList'

vi.mock('../lib/api/client', () => ({
  api: { list: vi.fn() },
}))

import { api } from '../lib/api/client'

afterEach(() => {
  ;(api.list as ReturnType<typeof vi.fn>).mockReset()
  vi.clearAllMocks()
})

describe('InsertableFileList', () => {
  it('fetches with recursive:false and renders files + directories under the current prefix', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: ['docs/images/', 'docs/data/'],
      files: [
        { key: 'docs/spec.md',   size: 100, lastModified: null },
        { key: 'docs/notes.txt', size:  50, lastModified: null },
      ],
      nextContinuation: null,
      nextStartAfter: null,
    })

    render(
      <InsertableFileList
        connId="c1"
        bucket="b1"
        prefix="docs/"
        onInsert={() => {}}
      />,
    )

    await screen.findByText(/spec\.md/)
    expect(api.list).toHaveBeenCalledWith('c1', 'b1', 'docs/', {}, { recursive: false })
    // basename だけが表示される (prefix の 'docs/' は剥がれる)
    expect(screen.getByText(/images\//)).toBeInTheDocument()
    expect(screen.getByText(/data\//)).toBeInTheDocument()
    expect(screen.getByText(/notes\.txt/)).toBeInTheDocument()
  })

  it('fires onInsert with { name, isDir:true, fullKey } when a directory row is clicked', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: ['docs/images/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const onInsert = vi.fn()
    const user = userEvent.setup()
    render(
      <InsertableFileList
        connId="c1"
        bucket="b1"
        prefix="docs/"
        onInsert={onInsert}
      />,
    )

    // ディレクトリ行の name ボタン (title="クリックして本文に挿入") をクリック
    const dirRowName = await screen.findByRole('button', { name: /images\// })
    await user.click(dirRowName)

    expect(onInsert).toHaveBeenCalledTimes(1)
    expect(onInsert).toHaveBeenCalledWith({
      name: 'images',
      isDir: true,
      fullKey: 'docs/images/',
    })
  })

  it('fires onInsert with isDir:false for a file row', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'docs/spec.md', size: 100, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const onInsert = vi.fn()
    const user = userEvent.setup()
    render(
      <InsertableFileList
        connId="c1"
        bucket="b1"
        prefix="docs/"
        onInsert={onInsert}
      />,
    )

    await user.click(await screen.findByRole('button', { name: /spec\.md/ }))
    expect(onInsert).toHaveBeenCalledWith({
      name: 'spec.md',
      isDir: false,
      fullKey: 'docs/spec.md',
    })
  })

  it('navigates into a subdirectory when "↓ 開く" is clicked, refetching with new prefix', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    listMock.mockResolvedValueOnce({
      directories: ['docs/sub/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'docs/sub/inside.md', size: 10, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const onInsert = vi.fn()
    const user = userEvent.setup()
    render(
      <InsertableFileList
        connId="c1"
        bucket="b1"
        prefix="docs/"
        onInsert={onInsert}
      />,
    )

    await screen.findByRole('button', { name: /sub\// })
    // 「↓ 開く」 を押す → prefix='docs/sub/' で再 fetch
    await user.click(screen.getByRole('button', { name: 'sub を開く' }))
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    expect(listMock.mock.calls[1]).toEqual(['c1', 'b1', 'docs/sub/', {}, { recursive: false }])

    // 中身が新しいリストに置き換わる
    await screen.findByText(/inside\.md/)
    // 「↓ 開く」 は副作用として prefix を変えるだけ — onInsert は発火していない
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('renders breadcrumbs and navigates up when a higher segment is clicked', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    // 1 回目: prefix='docs/sub/'
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'docs/sub/inside.md', size: 1, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })
    // 2 回目: prefix='docs/' (パン屑から戻る)
    listMock.mockResolvedValueOnce({
      directories: ['docs/sub/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    render(
      <InsertableFileList
        connId="c1"
        bucket="b1"
        prefix="docs/sub/"
        onInsert={() => {}}
      />,
    )
    await screen.findByText(/inside\.md/)

    // パン屑: bucket / docs / sub
    // 'docs' を押すと prefix='docs/' に戻る
    await user.click(screen.getByRole('button', { name: 'docs' }))
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    expect(listMock.mock.calls[1]).toEqual(['c1', 'b1', 'docs/', {}, { recursive: false }])
  })

  it('breadcrumb root (bucket name) navigates to empty prefix', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    listMock.mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'docs/sub/x.md', size: 1, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })
    listMock.mockResolvedValueOnce({
      directories: ['docs/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    render(
      <InsertableFileList
        connId="c1"
        bucket="b1"
        prefix="docs/sub/"
        onInsert={() => {}}
      />,
    )
    await screen.findByText(/x\.md/)

    // bucket 名 (== prefix='' へのリンク) を押す
    await user.click(screen.getByRole('button', { name: 'b1' }))
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2))
    expect(listMock.mock.calls[1]).toEqual(['c1', 'b1', '', {}, { recursive: false }])
  })

  it('shows empty-state text when the prefix has no entries', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: [],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    render(
      <InsertableFileList
        connId="c1"
        bucket="b1"
        prefix="empty/"
        onInsert={() => {}}
      />,
    )
    expect(await screen.findByText('エントリなし')).toBeInTheDocument()
  })

  it('shows a "many entries" hint when the response indicates more pages exist', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      directories: [],
      files: [{ key: 'docs/a.md', size: 1, lastModified: null }],
      nextContinuation: 'tok',
      nextStartAfter: null,
    })

    render(
      <InsertableFileList
        connId="c1"
        bucket="b1"
        prefix="docs/"
        onInsert={() => {}}
      />,
    )
    await screen.findByText(/a\.md/)
    expect(
      screen.getByText(/末端まで潜ってから挿入することをお勧めします/),
    ).toBeInTheDocument()
  })
})
