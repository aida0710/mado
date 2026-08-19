import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ScanSummary } from './ScanSummary'

const RESULT = {
  objectCount: 247078, totalBytes: 851893405098712,
  children: [], extensions: [], partial: false,
}

describe('ScanSummary', () => {
  // 走査済みなら押さなくても数字が見える。ここが Σ ボタンからの主な改善点。
  it('走査済みなら件数とサイズをその場に出す', () => {
    render(<ScanSummary result={RESULT} onOpen={() => {}} />)
    expect(screen.getByText(/247,078/)).toBeInTheDocument()
    expect(screen.getByText(/TB/)).toBeInTheDocument()
  })

  it('走査済みなら内訳を開ける', async () => {
    const onOpen = vi.fn()
    render(<ScanSummary result={RESULT} onOpen={onOpen} />)
    await userEvent.click(screen.getByRole('button', { name: '内訳' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('未走査なら集計を促す', async () => {
    const onOpen = vi.fn()
    render(<ScanSummary result={null} onOpen={onOpen} />)
    const btn = screen.getByRole('button', { name: '配下を集計する' })
    await userEvent.click(btn)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('partial なら断りを添える', () => {
    render(<ScanSummary result={{ ...RESULT, partial: true }} onOpen={() => {}} />)
    expect(screen.getByTitle(/途中まで/)).toBeInTheDocument()
  })
})

describe('走査中', () => {
  it('走査中はその旨を出し、押せば開ける', async () => {
    const onOpen = vi.fn()
    render(<ScanSummary result={null} running onOpen={onOpen} />)
    const btn = screen.getByRole('button', { name: /走査中/ })
    await userEvent.click(btn)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('前回の結果があっても走査中を優先して伝える', () => {
    render(<ScanSummary result={RESULT} running onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: /走査中/ })).toBeInTheDocument()
  })
})
