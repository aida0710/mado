import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewVideo } from './PreviewVideo'

describe('PreviewVideo', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    URL.createObjectURL = vi.fn(() => 'blob:video')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('単体MP4はRange対応video URLを直接使う', () => {
    render(<PreviewVideo connectionId="c" bucket="b" k="clip.mp4" />)
    const video = screen.getByLabelText('clip.mp4 の動画プレビュー')
    expect(video).toHaveAttribute('src', expect.stringContaining('/preview/video'))
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tar内MP4は取得後にblob URLで再生する', async () => {
    let resolveFetch!: (value: Response) => void
    vi.mocked(fetch).mockReturnValue(new Promise(resolve => { resolveFetch = resolve }))
    render(<PreviewVideo connectionId="c" bucket="b" k="shard.tar" entryPath="clip.mp4" />)
    expect(screen.getByText('動画を取得中…')).toBeInTheDocument()

    await act(async () => {
      resolveFetch({
        ok: true,
        blob: () => Promise.resolve(new Blob(['video'])),
      } as unknown as Response)
    })

    const video = await screen.findByLabelText('clip.mp4 の動画プレビュー')
    expect(video).toHaveAttribute('src', 'blob:video')
    await waitFor(() => expect(screen.queryByText('動画を取得中…')).not.toBeInTheDocument())
  })

  it('取得失敗を画面に表示する', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      statusText: 'Payload Too Large',
      json: () => Promise.resolve({ error: 'entry exceeds preview limit' }),
    } as unknown as Response)
    render(<PreviewVideo connectionId="c" bucket="b" k="shard.tar" entryPath="huge.mp4" />)
    expect(await screen.findByText(/entry exceeds preview limit/)).toBeInTheDocument()
  })
})
