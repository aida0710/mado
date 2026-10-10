import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HistoryModal } from './HistoryModal'

const versions = [
  { id: 2, editor: 'bob', edited_at: '2026-09-18T00:00:00Z', size_bytes: 20 },
  { id: 1, editor: 'alice', edited_at: '2026-09-17T00:00:00Z', size_bytes: 10 },
]
const bodies: Record<number, string> = { 2: '# 二版', 1: '# 初版' }

function renderModal(overrides: Partial<Parameters<typeof HistoryModal>[0]> = {}) {
  const onClose = vi.fn()
  render(
    <HistoryModal
      subtitle="テスト · 履歴"
      titleId="test-history-title"
      title="対象"
      currentBody={null}
      onClose={onClose}
      loadVersions={async () => versions}
      loadVersion={async id => ({ id, body: bodies[id] })}
      {...overrides}
    />,
  )
  return { onClose }
}

describe('HistoryModal', () => {
  it('開くと最新の版が選ばれて本文が表示される', async () => {
    renderModal()
    expect(await screen.findByRole('heading', { name: '二版' })).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    // 最新の版 (一覧の先頭) にだけ「最新」の印が付き、選択中になる。
    expect(screen.getByText('最新')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /bob/ })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /alice/ })).not.toHaveAttribute('aria-current')
  })

  it('別の版を選ぶとその本文に切り替わる', async () => {
    renderModal()
    await screen.findByRole('heading', { name: '二版' })
    await userEvent.click(screen.getByRole('button', { name: /alice/ }))
    expect(await screen.findByRole('heading', { name: '初版' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '二版' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /alice/ })).toHaveAttribute('aria-current', 'true')
  })

  it('選んだ版が現在の本文と同じなら「一致します」と出す', async () => {
    renderModal({ currentBody: '# 二版' })
    await screen.findByRole('heading', { name: '二版' })
    expect(screen.getByText('この版は現在の本文と一致します。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /alice/ }))
    await screen.findByRole('heading', { name: '初版' })
    expect(screen.queryByText('この版は現在の本文と一致します。')).not.toBeInTheDocument()
  })

  it('履歴が無ければその旨を出す', async () => {
    renderModal({ loadVersions: async () => [] })
    expect(await screen.findByText('履歴はありません。')).toBeInTheDocument()
  })

  it('Escape と閉じるボタンで onClose が呼ばれる', async () => {
    const { onClose } = renderModal()
    await screen.findByRole('heading', { name: '二版' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    // 背景のクリック用の見えないボタンも同じ名前を持つので、ダイアログの中の × を押す。
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '履歴を閉じる' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
