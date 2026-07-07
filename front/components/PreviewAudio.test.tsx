import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => vi.clearAllMocks())

describe('PreviewAudio', () => {
  it('解析結果で波形が出る / スペクトログラムはトグル', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [[-1, 1]], durationSec: 3, sampleRate: 16000, hasSpectrogram: true,
    })
    render(<PreviewAudio connId="c" bucket="b" k="a.wav" />)
    expect(screen.getByText('解析中…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('slider', { name: '再生位置' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'スペクトログラムを表示' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'スペクトログラム' })).not.toBeInTheDocument()
  })

  it('解析失敗は小さくエラー表示、再生 UI は残る', async () => {
    vi.mocked(api.mediaAnalyze).mockRejectedValue(new Error('解析できませんでした'))
    const { container } = render(<PreviewAudio connId="c" bucket="b" k="a.wav" />)
    await waitFor(() => expect(screen.getByText(/解析できませんでした/)).toBeInTheDocument())
    expect(container.querySelector('audio')).not.toBeNull()
  })

  it('entryPath があれば tar-entry URL を audio src に使い、analyze にも渡す', async () => {
    vi.mocked(api.mediaAnalyze).mockResolvedValue({
      cacheKey: 'ck', peaks: [], durationSec: null, sampleRate: null, hasSpectrogram: false,
    })
    const { container } = render(
      <PreviewAudio connId="c" bucket="b" k="shard.tar" entryPath="u1.wav" />,
    )
    const audio = container.querySelector('audio')!
    expect(audio.src).toContain('/preview/tar-entry')
    expect(audio.src).toContain('entry=u1.wav')
    await waitFor(() => expect(api.mediaAnalyze).toHaveBeenCalledWith(
      'c', 'b', 'shard.tar', expect.objectContaining({ entryPath: 'u1.wav' }),
    ))
  })
})
