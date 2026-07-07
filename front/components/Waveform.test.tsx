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
})
