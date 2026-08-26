import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ScanModal } from './ScanModal'
import { api } from '../../lib/api/client'

vi.mock('../../lib/api/client', () => ({
  api: {
    startScan: vi.fn(),
    getJob: vi.fn(),
    latestScan: vi.fn(),
    // Promise を返さないと ScanModal 側の .catch() で落ちる (unhandled error)。
    cancelJob: vi.fn().mockResolvedValue(undefined),
    estimate: vi.fn().mockResolvedValue(null),
  },
}))

const RESULT = {
  objectCount: 1234, totalBytes: 5_000_000_000,
  children: [{ name: 'sub/', objectCount: 1000, totalBytes: 4_000_000_000 }],
  extensions: [{ ext: '.tar', objectCount: 1234, totalBytes: 5_000_000_000 }],
  partial: false,
}

const mock = (fn: unknown): ReturnType<typeof vi.fn> => fn as ReturnType<typeof vi.fn>

beforeEach(() => vi.clearAllMocks())

describe('ScanModal', () => {
  it('保存済みの結果があれば開いた時点で出す', async () => {
    mock(api.latestScan).mockResolvedValue({
      id: 1, status: 'done', result: RESULT, finishedAt: '2026-08-18T07:00:00.000Z',
    })
    const { container } = render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await screen.findByText('オブジェクト')
    expect(container.querySelector('.scan-figures')?.textContent).toContain('1,234')
  })

  it('未走査なら実行を促す', async () => {
    mock(api.latestScan).mockResolvedValue(null)
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText(/まだ走査していません/)).toBeInTheDocument()
  })

  it('実行すると投入し、done になったら結果を出す', async () => {
    mock(api.latestScan).mockResolvedValue(null)
    mock(api.startScan).mockResolvedValue({ jobId: 9 })
    mock(api.getJob)
      .mockResolvedValueOnce({ id: 9, status: 'running', progress: { kind: 'count', done: 500 } })
      .mockResolvedValue({ id: 9, status: 'done', result: RESULT, finishedAt: null })

    const user = userEvent.setup()
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '走査する' }))

    expect(await screen.findByText(/500/)).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByText('オブジェクト')).toBeInTheDocument(),
      { timeout: 3000 },
    )
  })

  it('走査中はキャンセルできる', async () => {
    mock(api.latestScan).mockResolvedValue(null)
    mock(api.startScan).mockResolvedValue({ jobId: 9 })
    mock(api.getJob).mockResolvedValue({
      id: 9, status: 'running', progress: { kind: 'count', done: 1 },
    })

    const user = userEvent.setup()
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '走査する' }))
    await user.click(await screen.findByRole('button', { name: '中止' }))
    expect(api.cancelJob).toHaveBeenCalledWith(9)
  })

  it('partial なら断りを出す', async () => {
    mock(api.latestScan).mockResolvedValue({
      id: 1, status: 'done', result: { ...RESULT, partial: true }, finishedAt: null,
    })
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText(/集計は途中まで/)).toBeInTheDocument()
  })
})

describe('刷新後の表示', () => {
  it('拡張子別の内訳も出す (API が返しているのに捨てていた)', async () => {
    mock(api.latestScan).mockResolvedValue({
      id: 1, status: 'done', result: RESULT, finishedAt: '2026-08-18T07:00:00.000Z',
    })
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText('.tar')).toBeInTheDocument()
  })

  it('件数とサイズを別々の見出しで出す', async () => {
    mock(api.latestScan).mockResolvedValue({
      id: 1, status: 'done', result: RESULT, finishedAt: null,
    })
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText('オブジェクト')).toBeInTheDocument()
    expect(screen.getByText('合計サイズ')).toBeInTheDocument()
  })

  // 走査中と結果で骨格を保つ。完了時にレイアウトが飛ばないようにする。
  it('走査中も同じ figure 枠に数字を出す', async () => {
    mock(api.latestScan).mockResolvedValue(null)
    mock(api.startScan).mockResolvedValue({ jobId: 9 })
    mock(api.getJob).mockResolvedValue({
      id: 9, status: 'running', progress: { kind: 'count', done: 112000 },
    })
    const user = userEvent.setup()
    const { container } = render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await user.click(await screen.findByRole('button', { name: '走査する' }))
    expect(await screen.findByText('走査済み')).toBeInTheDocument()
    expect(container.querySelector('.scan-figures')).not.toBeNull()
  })
})

describe('リロード後の再接続', () => {
  // 走査はサーバー側 (worker) で走り続ける。リロードで jobId を失っても
  // 実行中のジョブを引き当てて進捗に戻れること。
  it('開いた時点で実行中なら、そのまま進捗を出す', async () => {
    mock(api.latestScan).mockResolvedValue({
      id: 42, status: 'running', progress: { kind: 'count', done: 88000 }, result: null,
    })
    mock(api.getJob).mockResolvedValue({
      id: 42, status: 'running', progress: { kind: 'count', done: 92000 }, result: null,
    })
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText('走査済み')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '中止' })).toBeInTheDocument()
    // 走査する ボタンは出ない (二重投入の入口を作らない)
    expect(screen.queryByRole('button', { name: '走査する' })).toBeNull()
  })

  it('実行中の結果は parse しない (result が null なので)', async () => {
    mock(api.latestScan).mockResolvedValue({
      id: 42, status: 'queued', progress: null, result: null,
    })
    mock(api.getJob).mockResolvedValue({ id: 42, status: 'queued', progress: null, result: null })
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText('走査済み')).toBeInTheDocument()
  })
})

describe('ScanModal — 移送の見積もりタブ', () => {
  it('既定は内訳タブ (見積もりは引かない)', async () => {
    mock(api.latestScan).mockResolvedValue({
      id: 1, status: 'done', result: RESULT, finishedAt: null,
    })
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await screen.findByText('オブジェクト')
    expect(api.estimate).not.toHaveBeenCalled()
  })

  it('タブを開くと同じ場所の見積もりを引く', async () => {
    mock(api.latestScan).mockResolvedValue({
      id: 1, status: 'done', result: RESULT, finishedAt: null,
    })
    mock(api.estimate).mockResolvedValue(null)

    const user = userEvent.setup()
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await user.click(await screen.findByRole('tab', { name: '移送の見積もり' }))

    await waitFor(() => expect(api.estimate).toHaveBeenCalledWith('c1', 'b1', 'p/'))
    // 内訳側の走査ボタンは隠れる (パネルごと切り替わる)。
    expect(screen.queryByRole('button', { name: '↻ 再走査' })).toBeNull()
  })

  it('見積もりタブから走査へ戻れる', async () => {
    mock(api.latestScan).mockResolvedValue(null)
    mock(api.estimate).mockResolvedValue(null)

    const user = userEvent.setup()
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    await user.click(await screen.findByRole('tab', { name: '移送の見積もり' }))
    // 未走査なので EstimatePanel が誘導を出す。
    await user.click(await screen.findByRole('button', { name: '走査する' }))

    // 内訳タブに戻り、そこの走査ボタンが押せる状態になる。
    expect(await screen.findByText(/まだ走査していません/)).toBeInTheDocument()
  })
})
