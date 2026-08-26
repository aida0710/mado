import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LineagePage from './LineagePage'
import { api } from '../lib/api/client'
import type { LineageGraph } from '../lib/api/types'

vi.mock('../components/lineage/LineageGraph', () => ({
  LineageGraph: ({ graph, onSelect }: {
    graph: LineageGraph
    onSelect: (node: LineageGraph['nodes'][number]) => void
  }) => (
    <div data-testid="lineage-graph">
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
  it('does not guess a root and explains how to start', async () => {
    renderPage()
    expect(screen.getByText('登録一覧からDatasetを選んでください')).toBeInTheDocument()
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

  it('loads a logical graph from URL-driven root fields', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue(graph)
    renderPage('/lineage?namespace=speech&name=raw&depth=2')
    expect(await screen.findByTestId('lineage-graph')).toBeInTheDocument()
    expect(api.lineageGraph).toHaveBeenCalledWith({
      mode: 'logical', rootKind: 'dataset', namespace: 'speech', name: 'raw', versionId: undefined, depth: 2,
    })
  })

  it('selects an opaque node through the URL and loads Registry detail', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue(graph)
    vi.mocked(api.lineageDataset).mockResolvedValue(dataset)
    renderPage('/lineage?namespace=speech&name=raw')
    fireEvent.click(await screen.findByRole('button', { name: 'CALLHOME raw' }))
    await waitFor(() => expect(api.lineageDataset).toHaveBeenCalledWith('dataset-1'))
    expect(screen.getByTestId('query')).toHaveTextContent('node=opaque%3Araw')
    expect(await screen.findByText('Purchased speech')).toBeInTheDocument()
  })

  it('uses an explicitly registered current version when switching projections', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue(graph)
    vi.mocked(api.lineageDataset).mockResolvedValue(dataset)
    renderPage('/lineage?namespace=speech&name=raw')
    fireEvent.click(await screen.findByRole('button', { name: 'CALLHOME raw' }))
    fireEvent.click(screen.getByRole('button', { name: '版・Runを表示' }))
    await waitFor(() => expect(api.lineageGraph).toHaveBeenLastCalledWith({
      mode: 'versions', rootKind: undefined, namespace: undefined, name: undefined,
      versionId: 'version-1', depth: 3,
    }))
  })

  it('shows truncation and backend warnings', async () => {
    vi.mocked(api.lineageGraph).mockResolvedValue({ ...graph, truncated: true, warnings: ['Marquez is stale'] })
    renderPage('/lineage?namespace=speech&name=raw')
    expect(await screen.findByText(/Depthを変える/)).toBeInTheDocument()
    expect(screen.getByText('Marquez is stale')).toBeInTheDocument()
  })

  it('shows fetch errors without leaving a blank canvas', async () => {
    vi.mocked(api.lineageGraph).mockRejectedValue(new Error('Registry unavailable'))
    renderPage('/lineage?namespace=speech&name=raw')
    expect(await screen.findByRole('alert')).toHaveTextContent('Registry unavailable')
  })
})
