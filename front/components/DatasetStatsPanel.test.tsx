import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatasetStatsPanel } from './DatasetStatsPanel'
import { api } from '../lib/api/client'

type ScanStatusResp = Awaited<ReturnType<typeof api.scanStatus>>

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return { api: { ...mod.api, scanStatus: vi.fn(), scanStart: vi.fn(), scanCancel: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

const openPanel = () => fireEvent.click(screen.getByText('データセット統計'))

describe('DatasetStatsPanel', () => {
  it('未スキャン: 実行ボタン → scanStart が呼ばれる', async () => {
    vi.mocked(api.scanStatus).mockResolvedValue({ job: null, stats: null, scannedAt: null })
    vi.mocked(api.scanStart).mockResolvedValue({ jobId: 1 })
    render(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'ds/' }} />)
    openPanel()
    const btn = await screen.findByRole('button', { name: 'スキャンを実行' })
    fireEvent.click(btn)
    await waitFor(() => expect(api.scanStart).toHaveBeenCalledWith('c', { bucket: 'b', prefix: 'ds/' }))
  })

  it('実行中: 進捗とキャンセルが出る', async () => {
    vi.mocked(api.scanStatus).mockResolvedValue({
      job: { id: 1, status: 'processing', progress: { filesDone: 3, filesTotal: 10, currentKey: 'x' }, error: null },
      stats: null, scannedAt: null,
    })
    render(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'ds/' }} />)
    openPanel()
    expect(await screen.findByText(/3 \/ 10/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(api.scanCancel).toHaveBeenCalledWith('c', 1))
  })

  it('完了: サマリとヒストグラムが出る', async () => {
    vi.mocked(api.scanStatus).mockResolvedValue({
      job: null,
      stats: {
        fileCount: 100, totalDurationSec: 7260, textFileCount: 100,
        vocabSize: 500, vocabTruncated: false, charSet: 40,
        durationHistogram: [{ le: 1, count: 10 }, { le: null, count: 5 }],
        sampleRates: { '16000': 100 }, topWords: [['の', 30]], truncated: false,
      },
      scannedAt: '2026-07-07T00:00:00Z',
    })
    render(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'ds/' }} />)
    openPanel()
    expect(await screen.findByText(/2h 1m/)).toBeInTheDocument()
    expect(screen.getByText(/100 ファイル/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '再スキャン' })).toBeInTheDocument()
  })

  it('スキャン開始失敗: エラーメッセージが表示される', async () => {
    vi.mocked(api.scanStatus).mockResolvedValue({ job: null, stats: null, scannedAt: null })
    vi.mocked(api.scanStart).mockRejectedValue(new Error('scan start failed'))
    render(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'ds/' }} />)
    openPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'スキャンを実行' }))
    expect(await screen.findByText('scan start failed')).toBeInTheDocument()
  })

  it('stale 防御: target 変更後に旧 target の応答が後着しても上書きしない', async () => {
    const doneStatus = (fileCount: number): ScanStatusResp => ({
      job: null,
      stats: {
        fileCount, totalDurationSec: 60, textFileCount: 1,
        vocabSize: 1, vocabTruncated: false, charSet: 1,
        durationHistogram: [{ le: 1, count: 1 }],
        sampleRates: {}, topWords: [], truncated: false,
      },
      scannedAt: '2026-07-07T00:00:00Z',
    })
    let resolveOld: ((v: ScanStatusResp) => void) | undefined
    vi.mocked(api.scanStatus).mockImplementation((_c, _b, t) =>
      t.prefix === 'old/'
        ? new Promise<ScanStatusResp>(r => { resolveOld = r })
        : Promise.resolve(doneStatus(200)),
    )
    const { rerender } = render(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'old/' }} />)
    openPanel()
    await waitFor(() => expect(resolveOld).toBeDefined())
    rerender(<DatasetStatsPanel connId="c" bucket="b" target={{ prefix: 'new/' }} />)
    expect(await screen.findByText(/200 ファイル/)).toBeInTheDocument()
    // 旧 target 向けの in-flight 応答が後着 → 世代照合で破棄され、新 target の表示のまま
    await act(async () => { resolveOld!(doneStatus(999)) })
    expect(screen.queryByText(/999 ファイル/)).not.toBeInTheDocument()
    expect(screen.getByText(/200 ファイル/)).toBeInTheDocument()
  })
})
