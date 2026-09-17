import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { S3PathPanel } from './S3PathPanel'

vi.mock('../lib/api/client', () => ({
  api: { list: vi.fn() },
}))

import { api } from '../lib/api/client'

afterEach(() => {
  ;(api.list as ReturnType<typeof vi.fn>).mockReset()
  vi.clearAllMocks()
})

function renderPanel() {
  return render(
    <MemoryRouter>
      <S3PathPanel connectionId="c1" />
    </MemoryRouter>,
  )
}

describe('S3PathPanel', () => {
  it('s3:// パスを解釈して bucket と prefix で api.list を呼ぶ', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      directories: ['debug/x/sub/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderPanel()
    await user.type(screen.getByLabelText('S3 パスで移動'), 's3://dataset/debug/x/')

    await waitFor(() =>
      expect(api.list).toHaveBeenCalledWith({ connectionId: 'c1', bucket: 'dataset', prefix: 'debug/x/', recursive: false }),
    )
  })

  it('treats an incomplete (no trailing slash) prefix as a prefix match — s3cmd ls 相当', async () => {
    const listMock = api.list as ReturnType<typeof vi.fn>
    // 不完全 prefix で前方一致したディレクトリが返る
    listMock.mockResolvedValue({
      directories: [
        'debug/dialogue-sidon-parakeet-v1/partition-test-1gpu-3h/',
        'debug/dialogue-sidon-parakeet-v1/partition-test-2gpu-6h/',
      ],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderPanel()
    await user.type(
      screen.getByLabelText('S3 パスで移動'),
      's3://dataset/debug/dialogue-sidon-parakeet-v1/partition-test-1gp',
    )

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({
        connectionId: 'c1', bucket: 'dataset', prefix: 'debug/dialogue-sidon-parakeet-v1/partition-test-1gp',
        recursive: false,
      }),
    )
    // 前方一致したディレクトリが「入力 prefix の最後の / 以降」の相対名で出る
    expect(await screen.findByText(/partition-test-1gpu-3h\//)).toBeInTheDocument()
    expect(screen.getByText(/partition-test-2gpu-6h\//)).toBeInTheDocument()
  })

  it('ディレクトリ行は StorageBucket ページへのリンクになる', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      directories: ['debug/x/sub/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderPanel()
    await user.type(screen.getByLabelText('S3 パスで移動'), 's3://dataset/debug/x/')

    const link = await screen.findByRole('link', { name: /sub\// })
    expect(link.getAttribute('href')).toBe('/storage/c1/dataset/debug/x/sub/')
  })

  it('ファイル行は親ディレクトリ + ?preview= へのリンクになる', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      directories: [],
      files: [{ key: 'debug/x/result.tar.xz', size: 1, lastModified: null }],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderPanel()
    await user.type(screen.getByLabelText('S3 パスで移動'), 's3://dataset/debug/x/')

    const link = await screen.findByRole('link', { name: /result\.tar\.xz/ })
    expect(link.getAttribute('href')).toBe(
      '/storage/c1/dataset/debug/x/?preview=debug%2Fx%2Fresult.tar.xz',
    )
  })

  it('shows an "→ 開く" link for a trailing-slash path (実在ディレクトリ指定)', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      directories: [],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderPanel()
    await user.type(screen.getByLabelText('S3 パスで移動'), 's3://dataset/debug/x/')

    const openLink = await screen.findByRole('link', { name: /を開く/ })
    expect(openLink.getAttribute('href')).toBe('/storage/c1/dataset/debug/x/')
  })

  it('does NOT show the "開く" link for an incomplete prefix (末尾スラッシュなし)', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      directories: ['debug/x/partition-1/'],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderPanel()
    await user.type(screen.getByLabelText('S3 パスで移動'), 's3://dataset/debug/x/partition')

    await screen.findByText(/partition-1\//)
    expect(screen.queryByRole('link', { name: /を開く/ })).toBeNull()
  })

  it('応答が打ち切られていれば「多すぎる」ことを示す', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      directories: ['debug/a/'],
      files: [],
      nextContinuation: 'tok',
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderPanel()
    await user.type(screen.getByLabelText('S3 パスで移動'), 's3://dataset/debug/')

    expect(
      await screen.findByText(/結果が多すぎます/),
    ).toBeInTheDocument()
  })

  it('shows "一致するパスがありません" when the listing is empty', async () => {
    ;(api.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      directories: [],
      files: [],
      nextContinuation: null,
      nextStartAfter: null,
    })

    const user = userEvent.setup()
    renderPanel()
    await user.type(screen.getByLabelText('S3 パスで移動'), 's3://dataset/nonexistent')

    expect(await screen.findByText('一致するパスがありません。')).toBeInTheDocument()
  })

  it('解釈できない (空の) 入力では api.list を呼ばない', async () => {
    const user = userEvent.setup()
    renderPanel()
    const input = screen.getByLabelText('S3 パスで移動')
    await user.type(input, 's3://')
    // 少し待っても api.list は呼ばれない
    await new Promise(r => setTimeout(r, 400))
    expect(api.list).not.toHaveBeenCalled()
  })
})
