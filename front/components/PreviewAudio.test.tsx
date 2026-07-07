import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewAudio } from './PreviewAudio'
import { api } from '../lib/api/client'

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      mediaAnalyze: vi.fn(),
    },
  }
})

// entryPath ありのケースは useAudioSrc が fetch → blob 化する。jsdom には
// URL.createObjectURL/revokeObjectURL が無いのでスタブする。
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  URL.createObjectURL = vi.fn(() => 'blob:mock-1')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('PreviewAudio', () => {
  it('解析結果で波形が出る / スペクトログラムは常時表示', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 3, sampleRate: 16000, hasSpectrogram: true, meta: null,
    })
    render(<PreviewAudio connId="c" bucket="b" k="a.wav" />)
    expect(screen.getByText('解析中…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('slider', { name: '再生位置' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /スペクトログラム/ })).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'スペクトログラム' })).toBeInTheDocument()
  })

  it('hasSpectrogram が false ならスペクトログラム画像を出さない', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 3, sampleRate: 16000, hasSpectrogram: false, meta: null,
    })
    render(<PreviewAudio connId="c" bucket="b" k="a.wav" />)
    await waitFor(() => expect(screen.getByRole('slider', { name: '再生位置' })).toBeInTheDocument())
    expect(screen.queryByRole('img', { name: 'スペクトログラム' })).not.toBeInTheDocument()
  })

  it('meta があれば情報行を最大 3 行表示する', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 12.345, sampleRate: 48000, hasSpectrogram: false,
      meta: {
        codec: 'flac', container: 'flac', channels: 2, bitsPerSample: 24,
        bitRate: 1411000, sizeBytes: 2097152, peakDb: -0.3, rmsDb: -18.2,
      },
    })
    render(<PreviewAudio connId="c" bucket="b" k="a.flac" />)
    await waitFor(() => expect(screen.getByText('FLAC · stereo · 48 kHz · 24 bit')).toBeInTheDocument())
    expect(screen.getByText('1411 kbps · 0:12.345 · 2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('peak -0.3 dBFS · RMS -18.2 dB')).toBeInTheDocument()
  })

  it('meta が null なら情報行を出さない', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 3, sampleRate: 16000, hasSpectrogram: false, meta: null,
    })
    const { container } = render(<PreviewAudio connId="c" bucket="b" k="a.wav" />)
    await waitFor(() => expect(screen.getByRole('slider', { name: '再生位置' })).toBeInTheDocument())
    expect(container.querySelector('.font-mono')).toBeNull()
  })

  it('解析失敗は小さくエラー表示、再生 UI は残る', async () => {
    vi.mocked(api.mediaAnalyze).mockRejectedValue(new Error('解析できませんでした'))
    const { container } = render(<PreviewAudio connId="c" bucket="b" k="a.wav" />)
    await waitFor(() => expect(screen.getByText(/解析できませんでした/)).toBeInTheDocument())
    expect(container.querySelector('audio')).not.toBeNull()
  })

  it('key の切替 (remount) で解析 state がリセットされる', async () => {
    // state リセットは effect 内の同期 setState ではなく呼び出し側の key remount に
    // 依存している。1 回目は即解決、2 回目は pending のままにして「解析中…」へ
    // 戻ることを担保する。
    vi.mocked(api.mediaAnalyze)
      .mockResolvedValueOnce({
        cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 3, sampleRate: 16000, hasSpectrogram: false, meta: null,
      })
      .mockImplementationOnce(() => new Promise(() => {}))
    const { rerender } = render(<PreviewAudio key="a" connId="c" bucket="b" k="a.wav" />)
    await waitFor(() => expect(screen.getByRole('slider', { name: '再生位置' })).toBeInTheDocument())

    rerender(<PreviewAudio key="b" connId="c" bucket="b" k="b.wav" />)
    expect(screen.queryByRole('slider', { name: '再生位置' })).not.toBeInTheDocument()
    expect(screen.getByText('解析中…')).toBeInTheDocument()
    expect(api.mediaAnalyze).toHaveBeenCalledTimes(2)
    expect(api.mediaAnalyze).toHaveBeenLastCalledWith(
      'c', 'b', 'b.wav', expect.objectContaining({ entryPath: undefined }),
    )
  })

  it('entryPath ありで blob 取得中は「音声を取得中…」が出て audio 要素に src が無い', () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false, meta: null,
    })
    vi.mocked(fetch).mockReturnValue(new Promise(() => {})) // 未解決のまま保持
    const { container } = render(
      <PreviewAudio connId="c" bucket="b" k="shard.tar" entryPath="u1.wav" />,
    )
    expect(screen.getByText('音声を取得中…')).toBeInTheDocument()
    expect(container.querySelector('audio')).toBeNull()
  })

  it('entryPath ありで blob 解決後に audio.src が blob: URL になり、analyze にも entryPath が渡る', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false, meta: null,
    })
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['data'])),
    } as unknown as Response)
    const { container } = render(
      <PreviewAudio connId="c" bucket="b" k="shard.tar" entryPath="u1.wav" />,
    )
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull())
    const audio = container.querySelector('audio')!
    expect(audio.src).toContain('blob:')
    expect(screen.queryByText('音声を取得中…')).not.toBeInTheDocument()
    await waitFor(() => expect(api.mediaAnalyze).toHaveBeenCalledWith(
      'c', 'b', 'shard.tar', expect.objectContaining({ entryPath: 'u1.wav' }),
    ))
  })

  it('entryPath ありで blob 取得失敗は小さくエラー表示される', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false, meta: null,
    })
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
      json: () => Promise.resolve({ error: 'entry not found' }),
    } as unknown as Response)
    render(<PreviewAudio connId="c" bucket="b" k="shard.tar" entryPath="u1.wav" />)
    await waitFor(() => expect(screen.getByText(/音声を取得できません/)).toBeInTheDocument())
    expect(screen.getByText(/entry not found/)).toBeInTheDocument()
  })
})
