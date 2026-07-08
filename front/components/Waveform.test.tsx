import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Waveform } from './Waveform'

beforeEach(() => {
  const ctx = {
    clearRect: vi.fn(), fillRect: vi.fn(), scale: vi.fn(),
    setTransform: vi.fn(), fillStyle: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
})

describe('Waveform', () => {
  it('canvas を slider role で描画する', () => {
    const { getByRole } = render(
      <Waveform peaks={[[-1, 1], [-0.5, 0.5]]} progress={0} />,
    )
    expect(getByRole('slider', { name: '再生位置' })).toBeInTheDocument()
  })

  it('クリック位置の比率で onSeek が呼ばれる', () => {
    const onSeek = vi.fn()
    const { getByRole } = render(
      <Waveform peaks={[[-1, 1]]} progress={0} onSeek={onSeek} />,
    )
    const el = getByRole('slider')
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
      { left: 0, width: 200, top: 0, height: 64, right: 200, bottom: 64, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    )
    fireEvent.click(el, { clientX: 50 })
    expect(onSeek).toHaveBeenCalledWith(0.25)
  })

  it('durationRatio<1 でピークが左寄せ (幅が縮む) に描画される', () => {
    const fillRect = vi.fn()
    const ctx = {
      clearRect: vi.fn(), fillRect, scale: vi.fn(), setTransform: vi.fn(), fillStyle: '',
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    // clientWidth を 200 に固定
    vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(200)

    render(<Waveform peaks={[[-1, 1], [-1, 1]]} progress={0} durationRatio={0.5} />)

    // ピークの塗り (bar) の x はすべて幅の左半分 (0〜100) に収まる。
    // 最後の fillRect は progress>0 のヘッド線だが progress=0 なので bar のみ。
    const barCalls = fillRect.mock.calls
    const maxX = Math.max(...barCalls.map(c => c[0] as number))
    expect(maxX).toBeLessThan(100)
  })
})
