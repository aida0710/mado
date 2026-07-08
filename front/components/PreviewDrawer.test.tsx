import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewDrawer } from './PreviewDrawer'
import { PinnedPreviewsProvider } from '../lib/pinnedPreviews'

vi.mock('../lib/api/client', () => ({
  api: { downloadUrl: vi.fn(() => 'http://x/dl') },
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

function Wrapper({ k, onClose = () => {} }: { k: string | null; onClose?: () => void }) {
  return (
    <PinnedPreviewsProvider>
      <PreviewDrawer connId="c" bucket="b" k={k} onClose={onClose} />
    </PinnedPreviewsProvider>
  )
}

describe('PreviewDrawer - pinned previews', () => {
  it('renders nothing when both k is null and there are no pins', () => {
    const { container } = render(<Wrapper k={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('📌 pins the current file and becomes disabled once pinned', () => {
    render(<Wrapper k="file.xyz" />)
    const pinBtn = screen.getByRole('button', { name: 'ピン留め' })
    expect(pinBtn).toBeEnabled()
    fireEvent.click(pinBtn)
    expect(screen.getByText('ピン留め (1)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'ピン留め済み' })).toBeDisabled()
  })

  it('shows only the pinned section (current preview hidden) once k becomes null but a pin remains', () => {
    const { rerender } = render(<Wrapper k="file.xyz" />)
    fireEvent.click(screen.getByRole('button', { name: 'ピン留め' }))
    rerender(<Wrapper k={null} />)
    expect(screen.getByText('ピン留め (1)')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close preview' })).not.toBeInTheDocument()
  })

  it('closing the current preview (✕) fires onClose but does not remove pins', () => {
    const onClose = vi.fn()
    render(<Wrapper k="file.xyz" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'ピン留め' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByText('ピン留め (1)')).toBeInTheDocument()
  })

  it('"全部外す" clears every pin', () => {
    render(<Wrapper k="file.xyz" />)
    fireEvent.click(screen.getByRole('button', { name: 'ピン留め' }))
    expect(screen.getByText('ピン留め (1)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '全部外す' }))
    expect(screen.queryByText(/ピン留め \(/)).not.toBeInTheDocument()
  })
})
