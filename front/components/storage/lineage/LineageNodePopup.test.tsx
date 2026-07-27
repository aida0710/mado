import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LineageNodePopup } from './LineageNodePopup'
import { api } from '../../../lib/api/client'
import type { LineageLink } from '../../../lib/api/types'

// LineageNodePopup は directory/bucket ノードで既存の ReadmeView をそのまま埋め込む。
// ReadmeView のヘッダーは react-router-dom の <Link> を常時レンダーするため、
// Router context 無しでは "Cannot destructure property 'basename' of
// useContext(...)" で例外になる — ReadmeView.test.tsx と同じく MemoryRouter で包む。
function renderPopup(ui: Parameters<typeof render>[0]) {
  return render(<MemoryRouter>{ui}</MemoryRouter>)
}

vi.mock('../../../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../../../lib/api/client')>()
  return { api: { ...mod.api, readme: vi.fn() } }
})

afterEach(() => vi.clearAllMocks())

const edges: LineageLink[] = [
  {
    id: 1, parentBucket: 'raw', parentPath: '2024-01/',
    childBucket: 'clean', childPath: 'v2/', createdBy: 'aida', createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 2, parentBucket: 'clean', parentPath: 'v2/',
    childBucket: 'export', childPath: 'final/', createdBy: 'aida', createdAt: '2026-01-01T00:00:00Z',
  },
]

describe('LineageNodePopup', () => {
  it('directory ノードでは README 冒頭を表示する', async () => {
    vi.mocked(api.readme).mockResolvedValue({
      exists: true, body: '# clean v2', last_editor: 'aida', last_edited_at: '2026-01-01T00:00:00Z', size_bytes: 10,
    })
    renderPopup(
      <LineageNodePopup
        connId="c1" node={{ bucket: 'clean', path: 'v2/' }} edges={edges}
        onNavigate={vi.fn()} onUnlink={vi.fn()} onClose={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('clean v2')).toBeInTheDocument())
  })

  it('直接の親・子を一覧表示し、解除ボタンで onUnlink(edgeId) を呼ぶ', async () => {
    vi.mocked(api.readme).mockResolvedValue({ exists: false })
    const onUnlink = vi.fn()
    renderPopup(
      <LineageNodePopup
        connId="c1" node={{ bucket: 'clean', path: 'v2/' }} edges={edges}
        onNavigate={vi.fn()} onUnlink={onUnlink} onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('raw/2024-01/')).toBeInTheDocument()
    expect(screen.getByText('export/final/')).toBeInTheDocument()

    const unlinkButtons = screen.getAllByRole('button', { name: '解除' })
    fireEvent.click(unlinkButtons[0])
    expect(onUnlink).toHaveBeenCalledWith(1)
  })

  it('「このパスへ移動」で onNavigate(node) を呼ぶ', async () => {
    vi.mocked(api.readme).mockResolvedValue({ exists: false })
    const onNavigate = vi.fn()
    renderPopup(
      <LineageNodePopup
        connId="c1" node={{ bucket: 'clean', path: 'v2/' }} edges={edges}
        onNavigate={onNavigate} onUnlink={vi.fn()} onClose={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'このパスへ移動' }))
    expect(onNavigate).toHaveBeenCalledWith({ bucket: 'clean', path: 'v2/' })
  })

  it('✕ ボタンで onClose を呼ぶ', async () => {
    vi.mocked(api.readme).mockResolvedValue({ exists: false })
    const onClose = vi.fn()
    renderPopup(
      <LineageNodePopup
        connId="c1" node={{ bucket: 'clean', path: 'v2/' }} edges={edges}
        onNavigate={vi.fn()} onUnlink={vi.fn()} onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(onClose).toHaveBeenCalled()
  })
})
