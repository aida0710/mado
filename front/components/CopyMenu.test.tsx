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

describe('CopyMenu - keyboard close', () => {
  const items: MenuItem[] = [
    { kind: 'copy', label: 'A', value: 'a' },
    { kind: 'copy', label: 'B', value: 'b' },
  ]

  // トリガーの onKeyDown は Enter/Space だけ止める (行の誤発火防止)。Escape は
  // 止めないので、開いた直後にトリガーへフォーカスが残った状態でも document の
  // keydown リスナに届き、メニューを閉じられる。
  it('closes on Escape while the trigger still has focus', async () => {
    const user = userEvent.setup()
    render(<CopyMenu items={items} />)
    const trigger = screen.getByRole('button', { name: 'アクション' })
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    // click 後もトリガーがフォーカスを保持している。そのまま Escape で閉じる。
    expect(trigger).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
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

// スマホ幅で「横に突き抜ける」不具合の回帰テスト。right をトリガ右端に揃える
// だけだと、トリガが画面左寄り (パンくず等) にあるとき right が大きくなりすぎ、
// メニューの左端が負の座標へ回り込んで見切れる。
describe('CopyMenu - horizontal clamping', () => {
  const items: MenuItem[] = [
    { kind: 'copy', label: 'A', value: 'a' },
    { kind: 'copy', label: 'B', value: 'b' },
  ]
  const MIN_W = 280
  const MARGIN = 8

  // jsdom の innerWidth は getter なので defineProperty で差し替える。
  const setViewportWidth = (w: number) => {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true })
  }
  const originalWidth = window.innerWidth
  afterEach(() => setViewportWidth(originalWidth))

  it('keeps the left edge on screen when the trigger sits far from the right edge', async () => {
    const user = userEvent.setup()
    render(<CopyMenu items={items} />)
    const trigger = screen.getByRole('button', { name: 'アクション' })
    // rect() のトリガは left=0/right=20 — 画面左端。素朴に right = innerWidth - 20
    // とすると左端が -260px になる。
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(80, 100))
    await user.click(trigger)
    const menu = screen.getByRole('menu')

    const right = parseFloat(menu.style.right)
    // 左端 = innerWidth - right - 幅。これが margin 以上なら画面内に収まっている。
    expect(window.innerWidth - right - MIN_W).toBeGreaterThanOrEqual(MARGIN)
  })

  it('shrinks the menu to the viewport on a phone-width screen', async () => {
    const user = userEvent.setup()
    setViewportWidth(360)
    render(<CopyMenu items={items} />)
    const trigger = screen.getByRole('button', { name: 'アクション' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(80, 100))
    await user.click(trigger)
    const menu = screen.getByRole('menu')

    // 幅が viewport - 左右マージンを超えない。min-width も同じ上限で丸める
    // (class の min-w-[280px] が残ると 360px 幅でもはみ出す)。
    expect(parseFloat(menu.style.maxWidth)).toBeLessThanOrEqual(360 - MARGIN * 2)
    expect(parseFloat(menu.style.minWidth)).toBeLessThanOrEqual(360 - MARGIN * 2)
    expect(parseFloat(menu.style.right)).toBeGreaterThanOrEqual(MARGIN)
  })

  it('still caps the width at 480px on a wide screen', async () => {
    const user = userEvent.setup()
    setViewportWidth(1600)
    render(<CopyMenu items={items} />)
    const trigger = screen.getByRole('button', { name: 'アクション' })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(80, 100))
    await user.click(trigger)
    const menu = screen.getByRole('menu')

    // デスクトップでは従来どおり 280〜480px。inline style が class の上限を
    // 広げてしまわないことの確認。
    expect(parseFloat(menu.style.maxWidth)).toBe(480)
    expect(parseFloat(menu.style.minWidth)).toBe(280)
  })
})
