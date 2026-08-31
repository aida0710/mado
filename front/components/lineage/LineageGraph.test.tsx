import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineageGraph as LineageGraphDto } from '../../lib/api/types'
import { LineageGraph } from './LineageGraph'

const fitView = vi.hoisted(() => vi.fn())
const flowState = vi.hoisted(() => ({
  nodes: [] as Array<{ id: string; className?: string }>,
  edges: [] as Array<{ id: string; className?: string }>,
}))

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => null,
  MiniMap: () => null,
  ReactFlow: ({ children, nodes, edges }: {
    children?: ReactNode
    nodes: Array<{ id: string; className?: string }>
    edges: Array<{ id: string; className?: string }>
  }) => {
    flowState.nodes = nodes
    flowState.edges = edges
    return <div>{children}</div>
  },
  ReactFlowProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({ fitView }),
}))

vi.mock('./LineageNode', () => ({ LineageNode: () => null }))

const graph: LineageGraphDto = {
  rootVersionId: 'raw',
  nodes: [
    { id: 'source', kind: 'source', label: 'Fisher Sidon', summary: {}, data: {} },
    { id: 'raw', kind: 'version', label: 'Fisher raw', namespace: 'speech', name: 'raw', summary: {}, data: { version: 'raw' } },
    { id: 'run', kind: 'run', label: 'codec変換', summary: {}, data: {} },
    { id: 'output', kind: 'version', label: 'moss-nano', namespace: 'speech', name: 'moss-nano', summary: {}, data: { version: 'v1' } },
    { id: 'other', kind: 'version', label: '別データ', summary: {}, data: { version: 'v1' } },
  ],
  edges: [
    { id: 'e1', source: 'source', target: 'raw', kind: 'source' },
    { id: 'e2', source: 'raw', target: 'run', kind: 'input' },
    { id: 'e3', source: 'run', target: 'output', kind: 'output' },
  ],
  truncated: false, warnings: [],
}

describe('LineageGraph', () => {
  beforeEach(() => {
    fitView.mockClear()
    flowState.nodes = []
    flowState.edges = []
  })

  it('選択されたノードを表示範囲の中央へ寄せる', async () => {
    render(<LineageGraph graph={graph} selectedId="run" onSelect={vi.fn()} onClearSelection={vi.fn()} />)

    await waitFor(() => expect(fitView).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ id: 'run' })],
      duration: 350,
    })))
  })

  it('方向を切り替えて該当経路だけを強調する', async () => {
    render(<LineageGraph graph={graph} selectedId="run" onSelect={vi.fn()} onClearSelection={vi.fn()} />)

    await waitFor(() => expect(flowState.nodes.find(node => node.id === 'other')?.className).toBe('lineage-flow-node--muted'))
    expect(flowState.nodes.find(node => node.id === 'output')?.className).toBe('lineage-flow-node--path')
    expect(flowState.edges.find(edge => edge.id === 'e3')?.className).toBe('lineage-flow-edge--path')

    fireEvent.click(screen.getByRole('button', { name: '上流' }))

    await waitFor(() => expect(flowState.nodes.find(node => node.id === 'output')?.className).toBe('lineage-flow-node--muted'))
    expect(flowState.nodes.find(node => node.id === 'source')?.className).toBe('lineage-flow-node--path')
    expect(flowState.edges.find(edge => edge.id === 'e3')?.className).toBe('lineage-flow-edge--muted')
  })

  it('グラフ内検索から対象ノードを選択する', async () => {
    const onSelect = vi.fn()
    render(<LineageGraph graph={graph} selectedId="" onSelect={onSelect} onClearSelection={vi.fn()} />)

    fireEvent.change(screen.getByRole('searchbox', { name: 'グラフ内検索' }), { target: { value: 'moss' } })
    fireEvent.click(await screen.findByRole('button', { name: /moss-nano/ }))

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'output' }))
    expect(screen.getByRole('searchbox', { name: 'グラフ内検索' })).toHaveValue('')
  })
})
