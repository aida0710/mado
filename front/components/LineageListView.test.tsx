import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/api/client'
import type { LineageLink } from '../lib/api/types'
import { LineageListView } from './LineageListView'

// React Flow の実物は jsdom で ResizeObserver 等を要求する。ここで見たいのは
// 「どのノード / エッジを渡すか」「コールバックで何を呼ぶか」なのでスタブに
// 差し替える。描画そのものは実ブラウザで確認している。
vi.mock('./storage/lineage/LineageFlowCanvas', () => ({
  default: ({ nodes, edges, onNodeDoubleClick, onEdgeClick, onConnect }: {
    nodes: Array<{ bucket: string; path: string }>
    edges: Array<{ ids: number[] }>
    onNodeDoubleClick: (n: { bucket: string; path: string }) => void
    onEdgeClick: (ids: number[]) => void
    onConnect: (p: { bucket: string; path: string }, c: { bucket: string; path: string }) => void
  }) => (
    <div data-testid="flow">
      <span data-testid="node-count">{nodes.length}</span>
      {nodes.map(n => (
        <button key={`${n.bucket}|${n.path}`} type="button" onClick={() => onNodeDoubleClick(n)}>
          {`go:${n.path === '' ? n.bucket : `${n.bucket}/${n.path}`}`}
        </button>
      ))}
      {edges.map(e => (
        <button key={e.ids.join(',')} type="button" onClick={() => onEdgeClick(e.ids)}>
          {`edge:${e.ids.join(',')}`}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onConnect({ bucket: 'out', path: 'final.csv' }, { bucket: 'raw', path: '2024-01/' })}
      >
        connect:drag
      </button>
    </div>
  ),
}))

afterEach(() => vi.restoreAllMocks())
beforeEach(() => localStorage.clear())

const link = (id: number, p: [string, string], c: [string, string]): LineageLink => ({
  id,
  parentBucket: p[0], parentPath: p[1],
  childBucket: c[0], childPath: c[1],
  createdBy: 'someone',
  createdAt: '2026-01-01T00:00:00.000Z',
})

function renderView() {
  return render(
    <MemoryRouter>
      <LineageListView connId="c1" />
    </MemoryRouter>,
  )
}

describe('LineageListView', () => {
  it('件数を出す', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
      link(2, ['clean', 'v2/'], ['out', 'final.csv']),
    ])
    renderView()
    expect(await screen.findByText('2 件')).toBeInTheDocument()
  })

  // エッジの端点からノードを起こす。同じノードが複数のエッジに出ても 1 つに畳む。
  it('エッジの端点を重複なくノードとして渡す', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([
      link(1, ['raw', '2024-01/'], ['clean', 'v2/']),
      link(2, ['clean', 'v2/'], ['out', 'final.csv']),
    ])
    renderView()
    expect(await screen.findByTestId('node-count')).toHaveTextContent('3')
  })

  it('ノードのダブルクリックでその場所へ移動する', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([link(1, ['raw', ''], ['clean', 'v2/'])])
    renderView()

    fireEvent.click(await screen.findByRole('button', { name: 'go:clean/v2/' }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))  // MemoryRouter なので URL は変わらない
  })

  // 1 クリックで消さない。必ず確認を挟む。
  it('エッジをクリックすると確認を出し、解除で removeLineageLink を呼ぶ', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([link(1, ['raw', ''], ['clean', 'v2/'])])
    const remove = vi.spyOn(api, 'removeLineageLink').mockResolvedValue(undefined)
    renderView()

    fireEvent.click(await screen.findByRole('button', { name: 'edge:1' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '解除' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('c1', 1))
  })

  it('編集者名が保存済みならドラッグ接続をそのまま確定する', async () => {
    localStorage.setItem('dashboard.lastEditor', 'aida')
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([link(1, ['raw', ''], ['clean', 'v2/'])])
    const add = vi.spyOn(api, 'addLineageLink').mockResolvedValue(9)
    renderView()

    fireEvent.click(await screen.findByRole('button', { name: 'connect:drag' }))
    await waitFor(() => expect(add).toHaveBeenCalledWith(
      'c1', { bucket: 'out', path: 'final.csv' }, { bucket: 'raw', path: '2024-01/' }, 'aida',
    ))
  })

  // グラフ上の操作だけで完結させるため、未登録のときはその場で聞く。
  it('編集者名が未登録ならその場で聞いてから保存する', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([link(1, ['raw', ''], ['clean', 'v2/'])])
    const add = vi.spyOn(api, 'addLineageLink').mockResolvedValue(9)
    renderView()

    fireEvent.click(await screen.findByRole('button', { name: 'connect:drag' }))
    expect(add).not.toHaveBeenCalled()

    fireEvent.change(await screen.findByLabelText('編集者名'), { target: { value: 'tanaka' } })
    fireEvent.click(screen.getByRole('button', { name: 'リンクを追加' }))

    await waitFor(() => expect(add).toHaveBeenCalledWith(
      'c1', { bucket: 'out', path: 'final.csv' }, { bucket: 'raw', path: '2024-01/' }, 'tanaka',
    ))
    expect(localStorage.getItem('dashboard.lastEditor')).toBe('tanaka')
  })

  it('リンクが無ければ空の案内を出す', async () => {
    vi.spyOn(api, 'lineageLinks').mockResolvedValue([])
    renderView()
    expect(await screen.findByText(/リンクがまだありません/)).toBeInTheDocument()
    expect(screen.queryByTestId('flow')).not.toBeInTheDocument()
  })

  it('取得に失敗したらエラーを出す', async () => {
    vi.spyOn(api, 'lineageLinks').mockRejectedValue(new Error('boom'))
    renderView()
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument())
  })
})
