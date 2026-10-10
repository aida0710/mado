import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parseLineageRoute } from '../../lib/lineage/route'
import { LineageToolbar } from './LineageToolbar'

function renderToolbar(query: string, onApply = vi.fn(), onModeChange = vi.fn()) {
  return render(
    <LineageToolbar
      route={parseLineageRoute(new URLSearchParams(query))}
      loading={false}
      onModeChange={onModeChange}
      onApply={onApply}
      onDepthChange={vi.fn()}
      onRefresh={vi.fn()}
    />,
  )
}

describe('LineageToolbar', () => {
  it('表示方法は押している方を aria-pressed で示し、押すと切り替える', () => {
    const onModeChange = vi.fn()
    renderToolbar('namespace=speech&name=raw', vi.fn(), onModeChange)

    expect(screen.getByRole('button', { name: 'データセット全体' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '入出力と処理履歴' }))
    expect(onModeChange).toHaveBeenCalledWith('versions')
  })

  it('技術IDで指定した起点を反映したら、重ねて開いた入力欄を閉じる', () => {
    const onApply = vi.fn()
    const { container } = renderToolbar('namespace=speech&name=raw', onApply)
    const technical = container.querySelector('details')!
    technical.open = true

    fireEvent.change(screen.getByLabelText('技術名'), { target: { value: 'clean' } })
    fireEvent.click(screen.getByRole('button', { name: '表示' }))

    expect(onApply).toHaveBeenCalledWith({ rootKind: 'dataset', namespace: 'speech', name: 'clean', versionId: '' })
    expect(technical.open).toBe(false)
  })
})
