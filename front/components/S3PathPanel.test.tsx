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
      <S3PathPanel connId="c1" />
    </MemoryRouter>,
  )
}

describe('S3PathPanel', () => {
  it('parses an s3:// path and calls api.list with the bucket + prefix', async () => {
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
      expect(api.list).toHaveBeenCalledWith('c1', 'dataset', 'debug/x/', {}, { recursive: false }),
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
      expect(listMock).toHaveBeenCalledWith(
        'c1', 'dataset', 'debug/dialogue-sidon-parakeet-v1/partition-test-1gp',
        {}, { recursive: false },
      ),
    )
    // 前方一致したディレクトリが「入力 prefix の最後の / 以降」の相対名で出る
    expect(await screen.findByText(/partition-test-1gpu-3h\//)).toBeInTheDocument()
    expect(screen.getByText(/partition-test-2gpu-6h\//)).toBeInTheDocument()
  })

  it('renders a directory row link to the StorageBucket page', async () => {
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

  it('renders a file row link that redirects to parent dir + ?preview=', async () => {
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

  it('shows a "too many results" hint when the response is truncated', async () => {
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

  it('does not call api.list for an unparseable (empty) input', async () => {
    const user = userEvent.setup()
    renderPanel()
    const input = screen.getByLabelText('S3 パスで移動')
    await user.type(input, 's3://')
    // 少し待っても api.list は呼ばれない
    await new Promise(r => setTimeout(r, 400))
    expect(api.list).not.toHaveBeenCalled()
  })
})
