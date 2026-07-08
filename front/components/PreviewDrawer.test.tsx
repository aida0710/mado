import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewDrawer } from './PreviewDrawer'
import { PinnedPreviewsProvider } from '../lib/pinnedPreviews'

vi.mock('../lib/api/client', () => ({
  api: {
    downloadUrl: vi.fn(() => 'http://x/dl'),
    // tar (アーカイブ) 用の PreviewArchive がマウントされた際に呼ばれる。
    // ピン留めボタンの有無だけを見るテストなので中身は解決させず放置してよい。
    tarPreview: vi.fn(() => new Promise(() => {})),
    invalidateTarPreview: vi.fn(),
    lastFetched: { tar: vi.fn(() => null) },
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})

const RESET = 'プレビュー幅を既定に戻す'

function renderDrawer(props: Partial<Parameters<typeof PreviewDrawer>[0]> = {}) {
  return render(
    <PreviewDrawer
      connId="c"
      bucket="b"
      k="file.xyz" // classify → unknown: fetch を伴うプレビューを描画しない
      onClose={() => {}}
      onResizeStart={() => {}}
      onResetWidth={() => {}}
      widthCustomized={false}
      {...props}
    />,
  )
}

describe('PreviewDrawer - width reset button', () => {
  it('is hidden until the width has been customized', () => {
    renderDrawer({ widthCustomized: false })
    expect(screen.queryByRole('button', { name: RESET })).toBeNull()
  })

  it('appears once customized and calls onResetWidth when clicked', async () => {
    const onResetWidth = vi.fn()
    renderDrawer({ widthCustomized: true, onResetWidth })
    await userEvent.click(screen.getByRole('button', { name: RESET }))
    expect(onResetWidth).toHaveBeenCalledOnce()
  })

  it('is not rendered when no reset handler is provided', () => {
    renderDrawer({ widthCustomized: true, onResetWidth: undefined })
    expect(screen.queryByRole('button', { name: RESET })).toBeNull()
  })
})

function Wrapper({
  k,
  onClose = () => {},
  ...rest
}: { k: string | null } & Partial<Parameters<typeof PreviewDrawer>[0]>) {
  return (
    <PinnedPreviewsProvider>
      <PreviewDrawer connId="c" bucket="b" k={k} onClose={onClose} {...rest} />
    </PinnedPreviewsProvider>
  )
}

describe('PreviewDrawer - pin button', () => {
  // ピン留めしたカードの表示は BottomDock が担う。ここではドロワーの 📌 が
  // 現在ファイルを Context に積み、積んだら無効化されることだけを検証する。
  it('renders nothing when k is null', () => {
    const { container } = render(<Wrapper k={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('📌 pins the current file and becomes disabled once pinned', () => {
    render(<Wrapper k="file.xyz" />)
    const pinBtn = screen.getByRole('button', { name: 'ピン留め' })
    expect(pinBtn).toBeEnabled()
    fireEvent.click(pinBtn)
    // 積んだら同じ k に対しては無効化される (Context 更新で再レンダ)。
    expect(screen.getByRole('button', { name: 'ピン留め済み' })).toBeDisabled()
  })

  it('closing the current preview (✕) fires onClose', () => {
    const onClose = vi.fn()
    render(<Wrapper k="file.xyz" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  // tar アーカイブ自体はピン留め対象外 (個々のエントリは PreviewArchive の
  // ⋯ メニューからピン留めできる)。ドロワーの 📌 はアーカイブ全体には出さない。
  it('tar アーカイブ (classify → archive) では 📌 ボタンが出ない', () => {
    render(<Wrapper k="a.tar" />)
    expect(screen.queryByRole('button', { name: 'ピン留め' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'ピン留め済み' })).not.toBeInTheDocument()
  })

  it('非アーカイブ (unknown) では引き続き 📌 ボタンが出る', () => {
    render(<Wrapper k="file.xyz" />)
    expect(screen.getByRole('button', { name: 'ピン留め' })).toBeInTheDocument()
  })
})
