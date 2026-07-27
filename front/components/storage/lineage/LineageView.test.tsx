import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LineageView } from './LineageView'
import { api } from '../../../lib/api/client'
import type { LineageLink } from '../../../lib/api/types'

// React Flow の実物は jsdom で ResizeObserver 等を要求し、ここで見たいのは
// LineageView 側の配線 (どのノード/エッジを渡すか、コールバックで何を呼ぶか) なので
// キャンバスはスタブに差し替える。描画そのものは実ブラウザで確認している。
vi.mock('./LineageFlowCanvas', () => ({
  default: ({ nodes, edges, onNodeClick, onEdgeClick, onConnect, isCycle }: {
    nodes: Array<{ bucket: string; path: string }>
    edges: Array<{ ids: number[]; parent: { bucket: string; path: string }; child: { bucket: string; path: string } }>
    onNodeClick: (n: { bucket: string; path: string }) => void
    onEdgeClick: (ids: number[]) => void
    onConnect: (p: { bucket: string; path: string }, c: { bucket: string; path: string }) => void
    isCycle: (p: { bucket: string; path: string }, c: { bucket: string; path: string }) => boolean
  }) => (
    <div data-testid="flow">
      {nodes.map(n => (
        <button key={`${n.bucket}|${n.path}`} type="button" onClick={() => onNodeClick(n)}>
          {n.path === '' ? n.bucket : `${n.bucket}/${n.path}`}
        </button>
      ))}
      {edges.map(e => (
        <button key={e.ids.join(',')} type="button" onClick={() => onEdgeClick(e.ids)}>
          {`edge:${e.ids.join(',')}`}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onConnect({ bucket: 'raw', path: '2024-01/' }, { bucket: 'clean', path: 'v2/' })}
      >
        connect:drag
      </button>
      <span data-testid="cycle">
        {String(isCycle({ bucket: 'clean', path: 'v2/' }, { bucket: 'raw', path: '2024-01/' }))}
      </span>
    </div>
  ),
}))

vi.mock('../../../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../../../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      lineageLinks: vi.fn(),
      addLineageLink: vi.fn(),
      removeLineageLink: vi.fn(),
      readme: vi.fn(),
      buckets: vi.fn(),
      list: vi.fn(),
    },
  }
})

const edges: LineageLink[] = [
  {
    id: 1, parentBucket: 'raw', parentPath: '2024-01/',
    childBucket: 'clean', childPath: 'v2/', createdBy: 'aida', createdAt: '2026-01-01T00:00:00Z',
  },
]

beforeEach(() => {
  localStorage.clear()
  vi.mocked(api.readme).mockResolvedValue({ exists: false })
})
afterEach(() => vi.clearAllMocks())

function renderView() {
  return render(
    <MemoryRouter>
      <LineageView connId="c1" bucket="clean" prefix="v2/" />
    </MemoryRouter>,
  )
}

describe('LineageView', () => {
  it('マウント時にエッジを取得し、現在地スコープで中心ノードを描画する', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    renderView()
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalledWith('c1'))
    expect(await screen.findByRole('button', { name: /clean\/v2\// })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '現在地' })).toHaveAttribute('aria-selected', 'true')
  })

  it('スコープタブを切り替えると全エッジを渡す', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    renderView()
    await screen.findByRole('button', { name: /clean\/v2\// })

    fireEvent.click(screen.getByRole('tab', { name: '全て' }))
    expect(await screen.findByRole('button', { name: /raw\/2024-01\// })).toBeInTheDocument()
  })

  it('ノードをクリックするとポップアップが開き、解除で removeLineageLink が呼ばれ再取得する', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    vi.mocked(api.removeLineageLink).mockResolvedValue(undefined)
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: /clean\/v2\// }))

    const unlinkBtn = await screen.findByRole('button', { name: '解除' })
    fireEvent.click(unlinkBtn)
    await waitFor(() => expect(api.removeLineageLink).toHaveBeenCalledWith('c1', 1))
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalledTimes(2))
  })

  // グラフ上のドラッグ接続。ピッカー経由と違い編集者名は保存済みのものを使う。
  it('ドラッグ接続で addLineageLink が呼ばれる', async () => {
    localStorage.setItem('dashboard.lastEditor', 'aida')
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    vi.mocked(api.addLineageLink).mockResolvedValue(99)
    renderView()

    fireEvent.click(await screen.findByRole('button', { name: 'connect:drag' }))
    await waitFor(() => expect(api.addLineageLink).toHaveBeenCalledWith(
      'c1',
      { bucket: 'raw', path: '2024-01/' },
      { bucket: 'clean', path: 'v2/' },
      'aida',
    ))
  })

  it('編集者名が未登録ならドラッグ接続を保存せず案内を出す', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    renderView()

    fireEvent.click(await screen.findByRole('button', { name: 'connect:drag' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('編集者名')
    expect(api.addLineageLink).not.toHaveBeenCalled()
  })

  // 閉路になる向きはドロップ前に弾く (サーバの 409 と同じルール)。
  it('閉路になる組み合わせを isCycle が true と判定する', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    renderView()
    expect(await screen.findByTestId('cycle')).toHaveTextContent('true')
  })

  it('エッジをクリックすると removeLineageLink が呼ばれる', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue(edges)
    vi.mocked(api.removeLineageLink).mockResolvedValue(undefined)
    renderView()

    fireEvent.click(await screen.findByRole('button', { name: 'edge:1' }))
    await waitFor(() => expect(api.removeLineageLink).toHaveBeenCalledWith('c1', 1))
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalledTimes(2))
  })

  it('親を追加フロー: ピッカーで選択 → 編集者名入力 → addLineageLink が正しい引数で呼ばれる', async () => {
    vi.mocked(api.lineageLinks).mockResolvedValue([])
    vi.mocked(api.buckets).mockResolvedValue({
      buckets: [{ name: 'raw', creationDate: null }, { name: 'clean', creationDate: null }],
    })
    vi.mocked(api.list).mockResolvedValue({
      directories: [], files: [{ key: 'source.wav', size: 1, lastModified: null }],
      nextContinuation: null, nextStartAfter: null,
    })
    vi.mocked(api.addLineageLink).mockResolvedValue(99)

    renderView()
    await waitFor(() => expect(api.lineageLinks).toHaveBeenCalled())

    // ピッカーは LineageView 側の bucket/prefix ('clean' / 'v2/') を初期値に開く。
    // api.list は引数によらず同じ file を返すモックなので、バケットを切り替えずに選択できる。
    fireEvent.click(screen.getByRole('button', { name: '＋ 親を追加' }))
    fireEvent.click(await screen.findByRole('button', { name: '選択' }))

    const nameInput = await screen.findByLabelText('編集者名')
    fireEvent.change(nameInput, { target: { value: 'aida' } })
    fireEvent.click(screen.getByRole('button', { name: 'リンクを追加' }))

    await waitFor(() => expect(api.addLineageLink).toHaveBeenCalledWith(
      'c1',
      { bucket: 'clean', path: 'source.wav' },
      { bucket: 'clean', path: 'v2/' },
      'aida',
    ))
    expect(localStorage.getItem('dashboard.lastEditor')).toBe('aida')
  })
})
