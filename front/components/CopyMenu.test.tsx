import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyMenu, type MenuItem } from './CopyMenu'

vi.mock('../lib/clipboard', () => ({
  copyToClipboard: vi.fn(async () => true),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

// getBoundingClientRect の最小モック。top / bottom だけ effect が参照する。
const rect = (top: number, bottom: number): DOMRect =>
  ({
    top, bottom, left: 0, right: 20, width: 20, height: bottom - top, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect

describe('CopyMenu - download item alignment', () => {
  // ダウンロード項目 (<a>) は td の text-right を継承して右寄せにならないよう、
  // コピー項目 (<button>) と同じく text-left を明示している。
  it('left-aligns the download link like the copy items', async () => {
    const user = userEvent.setup()
    const items: MenuItem[] = [
      { kind: 'download', label: 'このファイルをダウンロード', href: 'http://x/dl', filename: 'f.bin' },
      { kind: 'copy', label: 'S3 URL をコピー', value: 's3://b/k' },
    ]
    render(<CopyMenu items={items} />)
    await user.click(screen.getByRole('button', { name: 'アクション' }))
    const dl = screen.getByRole('menuitem', { name: 'このファイルをダウンロード' })
    expect(dl.className).toContain('text-left')
  })
})

describe('CopyMenu - open direction (portal + fixed)', () => {
  const items: MenuItem[] = [
    { kind: 'copy', label: 'A', value: 'a' },
    { kind: 'copy', label: 'B', value: 'b' },
  ]

  it('renders the menu fixed-positioned outside the row (portaled to body)', async () => {
    const user = userEvent.setup()
    const { container } = render(<CopyMenu items={items} />)
    const trigger = screen.getByRole('button', { name: 'アクション' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(80, 100))
    await user.click(trigger)
    const menu = screen.getByRole('menu')
    // overflow ラッパーにクリップされないよう body 直下に portal される。
    expect(container).not.toContainElement(menu)
    expect(document.body).toContainElement(menu)
    expect(menu.style.position).toBe('fixed')
  })

  it('opens downward when there is room below the trigger', async () => {
    const user = userEvent.setup()
    render(<CopyMenu items={items} />)
    const trigger = screen.getByRole('button', { name: 'アクション' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(80, 100))
    await user.click(trigger)
    const menu = screen.getByRole('menu')
    expect(menu.style.top).not.toBe('') // r.bottom + gap
    expect(menu.style.bottom).toBe('')
  })

  it('flips upward when the trigger sits near the bottom of the viewport', async () => {
    const user = userEvent.setup()
    render(<CopyMenu items={items} />)
    const trigger = screen.getByRole('button', { name: 'アクション' })
    // jsdom の既定 window.innerHeight=768。下端付近に置くと下に収まらない。
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(740, 760))
    await user.click(trigger)
    const menu = screen.getByRole('menu')
    expect(menu.style.bottom).not.toBe('')
    expect(menu.style.top).toBe('')
  })
})
