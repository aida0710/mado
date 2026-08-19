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
    cancelJob: vi.fn(),
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
    render(<ScanModal connId="c1" bucket="b1" prefix="p/" onClose={() => {}} />)
    expect(await screen.findByText(/1,234/)).toBeInTheDocument()
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
    await waitFor(() => expect(screen.getByText(/1,234/)).toBeInTheDocument(), { timeout: 3000 })
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
