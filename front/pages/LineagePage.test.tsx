import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LineagePage from './LineagePage'
import { api } from '../lib/api/client'
import type { LineageGraph } from '../lib/api/types'

vi.mock('../components/lineage/LineageGraph', () => ({
  LineageGraph: ({ graph, selectedId, onSelect }: {
    graph: LineageGraph
    selectedId: string
    onSelect: (node: LineageGraph['nodes'][number]) => void
  }) => (
    <div data-testid="lineage-graph">
      <output data-testid="selected-node">{selectedId}</output>
      {graph.nodes.map(node => <button key={node.id} onClick={() => onSelect(node)}>{node.label}</button>)}
    </div>
  ),
}))

vi.mock('../lib/api/client', async importOriginal => {
  const mod = await importOriginal<typeof import('../lib/api/client')>()
  return {
    api: {
      ...mod.api,
      lineageGraph: vi.fn(),
      lineageDataset: vi.fn(),
      lineageVersion: vi.fn(),
      lineageRun: vi.fn(),
      lineageCatalog: vi.fn().mockResolvedValue({ results: [], totalCount: 0 }),
    },
  }
})
afterEach(() => vi.clearAllMocks())

const graph: LineageGraph = {
  root: { kind: 'dataset', namespace: 'speech', name: 'raw', nodeId: 'opaque:raw' },
  nodes: [{
    id: 'opaque:raw', kind: 'dataset', label: 'CALLHOME raw', namespace: 'speech', name: 'raw',
    summary: {}, data: {}, status: null, completeness: 'complete',
    registry: {
      kind: 'dataset', datasetId: 'dataset-1', datasetKey: 'callhome', namespace: 'speech', name: 'raw',
      displayName: 'CALLHOME raw', aliases: [],
      description: null, mediaType: 'audio', owner: null, currentVersionId: 'version-1', versionCount: 1,
    },
    latestRun: null,
  }],
  edges: [], projection: { state: 'synced', pendingEvents: 0, oldestPendingAt: null },
  generatedAt: '2026-08-26T00:00:00Z', truncated: false, warnings: [],
}

const versionGraph: LineageGraph = {
  rootVersionId: 'version-1',
  nodes: [{
    id: 'version-1', kind: 'version', label: 'CALLHOME raw · v1', namespace: 'speech', name: 'raw',
    summary: {}, data: { version: 'v1' }, status: null,
  }],
  edges: [], projection: { state: 'synced', pendingEvents: 0, oldestPendingAt: null },
  generatedAt: '2026-08-26T00:00:00Z', truncated: false, warnings: [],
}

const dataset = {
  kind: 'dataset' as const, datasetId: 'dataset-1', datasetKey: 'callhome', namespace: 'speech', name: 'raw',
  displayName: 'CALLHOME raw', aliases: [],
  description: 'Purchased speech', mediaType: 'audio', owner: null, currentVersionId: 'version-1',
  versionCount: 1, createdAt: '2026-08-26T00:00:00Z', versions: [{
    id: 'version-1', datasetId: 'dataset-1', version: 'v1', contentHash: null, manifestUri: 's3://meta/manifest.jsonl',
    manifestHash: 'sha256:abc', schemaUri: null, createdAt: '2026-08-26T00:00:00Z', metadata: {}, locations: [],
  }],
}

function Query() {
  const location = useLocation()
  return <output data-testid="query">{location.search}</output>
}

function renderPage(entry = '/lineage') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path="/lineage" element={<><LineagePage /><Query /></>} /></Routes>
    </MemoryRouter>,
  )
}

describe('LineagePage', () => {
  it('起点を推測せず、どう始めるかを案内する', async () => {
    renderPage()
    expect(screen.getByText('登録一覧からデータセットを選んでください')).toBeInTheDocument()
    expect(await screen.findByText('登録 0件')).toBeInTheDocument()
    expect(api.lineageGraph).not.toHaveBeenCalled()
  })

  it('登録一覧から機械identityを選びURLへ反映する', async () => {
    vi.mocked(api.lineageCatalog).mockResolvedValue({
      results: [{
        kind: 'dataset', datasetId: 'dataset-1', datasetKey: 'callhome',
        namespace: 'speech', name: 'raw', displayName: 'CALLHOME raw', aliases: [],
        description: 'Purchased speech', mediaType: 'audio', owner: null,
        currentVersionId: 'version-1', versionCount: 1,
      }],
      totalCount: 1,
    })
    vi.mocked(api.lineageGraph).mockResolvedValue(graph)
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: /CALLHOME raw/ }))

    expect(await screen.findByTestId('lineage-graph')).toBeInTheDocument()
    expect(screen.getByTestId('query')).toHaveTextContent('namespace=speech')
    expect(screen.getByTestId('query')).toHaveTextContent('name=raw')
  })

  it('URL の起点指定から logical グラフを読む', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue(graph)
    renderPage('/lineage?namespace=speech&name=raw&depth=2')
    expect(await screen.findByTestId('lineage-graph')).toBeInTheDocument()
    expect(api.lineageGraph).toHaveBeenCalledWith({
      mode: 'logical', rootKind: 'dataset', namespace: 'speech', name: 'raw', versionId: undefined, depth: 2,
    })
  })

  it('URL で指定したノードを選び、Registry の詳細を読む', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue(graph)
    vi.mocked(api.lineageDataset).mockResolvedValue(dataset)
    renderPage('/lineage?namespace=speech&name=raw')
    fireEvent.click(await screen.findByRole('button', { name: 'CALLHOME raw' }))
    await waitFor(() => expect(api.lineageDataset).toHaveBeenCalledWith('dataset-1'))
    expect(screen.getByTestId('query')).toHaveTextContent('node=opaque%3Araw')
    expect(await screen.findByText('Purchased speech')).toBeInTheDocument()
  })

  it('表示を切り替えるとき、明示された現在版を使う', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue(graph)
    vi.mocked(api.lineageDataset).mockResolvedValue(dataset)
    renderPage('/lineage?namespace=speech&name=raw')
    fireEvent.click(await screen.findByRole('button', { name: 'CALLHOME raw' }))
    fireEvent.click(screen.getByRole('button', { name: '入出力と処理履歴' }))
    await waitFor(() => expect(api.lineageGraph).toHaveBeenLastCalledWith({
      mode: 'versions', rootKind: undefined, namespace: undefined, name: undefined,
      versionId: 'version-1', depth: 3,
    }))
  })

  it('打ち切りと backend の警告を出す', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue({ ...graph, truncated: true, warnings: ['Marquez is stale'] })
    renderPage('/lineage?namespace=speech&name=raw')
    expect(await screen.findByText(/表示範囲を広げる/)).toBeInTheDocument()
    expect(screen.getByText('Marquez is stale')).toBeInTheDocument()
  })

  it('取得に失敗しても白紙にせず理由を出す', async () => {
    vi.mocked(api.lineageGraph).mockRejectedValue(new Error('Registry unavailable'))
    renderPage('/lineage?namespace=speech&name=raw')
    expect(await screen.findByRole('alert')).toHaveTextContent('Registry unavailable')
  })

  it('バージョンURLの起点を選択し詳細を開く', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue(versionGraph)
    vi.mocked(api.lineageVersion).mockResolvedValue(dataset.versions[0])
    renderPage('/lineage?mode=versions&versionId=version-1')

    await waitFor(() => expect(screen.getByTestId('selected-node')).toHaveTextContent('version-1'))
    await waitFor(() => expect(api.lineageVersion).toHaveBeenCalledWith('version-1'))
    expect(screen.getByTestId('query')).toHaveTextContent('node=version-1')
    expect(await screen.findByText('s3://meta/manifest.jsonl')).toBeInTheDocument()
  })
})
