import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LineageGraphCanvas, type LineageLayout } from './LineageGraphCanvas'

describe('LineageGraphCanvas', () => {
  it('current スコープ: 祖先/中心/子孫を列で描画し、クリックで onNodeClick を呼ぶ', () => {
    const onNodeClick = vi.fn()
    const layout: LineageLayout = {
      scope: 'current',
      center: { bucket: 'clean', path: 'v2/' },
      ancestorGenerations: [[{ bucket: 'raw', path: '2024-01/' }]],
      descendantGenerations: [[{ bucket: 'export', path: 'final/' }]],
    }
    render(<LineageGraphCanvas layout={layout} onNodeClick={onNodeClick} />)

    fireEvent.click(screen.getByRole('button', { name: /raw\/2024-01\// }))
    expect(onNodeClick).toHaveBeenCalledWith({ bucket: 'raw', path: '2024-01/' })

    fireEvent.click(screen.getByRole('button', { name: /clean\/v2\// }))
    expect(onNodeClick).toHaveBeenCalledWith({ bucket: 'clean', path: 'v2/' })

    fireEvent.click(screen.getByRole('button', { name: /export\/final\// }))
    expect(onNodeClick).toHaveBeenCalledWith({ bucket: 'export', path: 'final/' })
  })

  it('current スコープ: リンクが無ければ空状態メッセージを出す', () => {
    const layout: LineageLayout = {
      scope: 'current',
      center: { bucket: 'clean', path: 'v2/' },
      ancestorGenerations: [],
      descendantGenerations: [],
    }
    render(<LineageGraphCanvas layout={layout} onNodeClick={vi.fn()} />)
    expect(screen.getByText('登録されたリンクがありません。')).toBeInTheDocument()
  })

  it('all/bucket スコープ: 親→子のエッジ一覧を描画する', () => {
    const onNodeClick = vi.fn()
    const layout: LineageLayout = {
      scope: 'bucket',
      edges: [{ id: 'e1', parent: { bucket: 'raw', path: '' }, child: { bucket: 'clean', path: '' } }],
    }
    render(<LineageGraphCanvas layout={layout} onNodeClick={onNodeClick} />)
    fireEvent.click(screen.getByRole('button', { name: /^📦 raw/ }))
    expect(onNodeClick).toHaveBeenCalledWith({ bucket: 'raw', path: '' })
  })

  it('all/bucket スコープ: エッジが無ければ空状態メッセージを出す', () => {
    render(<LineageGraphCanvas layout={{ scope: 'all', edges: [] }} onNodeClick={vi.fn()} />)
    expect(screen.getByText('登録されたリンクがありません。')).toBeInTheDocument()
  })
})
