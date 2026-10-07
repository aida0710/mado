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

  it('非圧縮tar内MP4はHEADで準備した後にRange対応URLを直接使う', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))
    render(<PreviewVideo connectionId="c" bucket="b" k="SHARD.TAR" entryPath="clip.mp4" />)
    const video = await screen.findByLabelText('clip.mp4 の動画プレビュー')
    expect(video).toHaveAttribute('src', expect.stringContaining('/preview/tar-entry'))
    expect(video).toHaveAttribute('src', expect.stringContaining('entry=clip.mp4'))
    expect(video).toHaveAttribute('preload', 'metadata')
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/preview/tar-entry'), expect.objectContaining({ method: 'HEAD' }))
    expect(fetch).toHaveBeenCalledOnce()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('圧縮tar内MP4は取得後にblob URLで再生する', async () => {
    let resolveFetch!: (value: Response) => void
    vi.mocked(fetch).mockReturnValue(new Promise(resolve => { resolveFetch = resolve }))
    render(<PreviewVideo connectionId="c" bucket="b" k="shard.tar.gz" entryPath="clip.mp4" />)
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
    render(<PreviewVideo connectionId="c" bucket="b" k="shard.tar.gz" entryPath="huge.mp4" />)
    expect(await screen.findByText(/entry exceeds preview limit/)).toBeInTheDocument()
  })
})
