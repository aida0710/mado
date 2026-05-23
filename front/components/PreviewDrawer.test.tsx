import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewDrawer } from './PreviewDrawer'

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
