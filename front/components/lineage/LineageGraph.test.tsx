import type { ReactNode } from 'react'
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LineageGraph as LineageGraphDto } from '../../lib/api/types'
import { LineageGraph } from './LineageGraph'

const fitView = vi.hoisted(() => vi.fn())

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => null,
  MiniMap: () => null,
  ReactFlow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ReactFlowProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  useReactFlow: () => ({ fitView }),
}))

vi.mock('./LineageNode', () => ({ LineageNode: () => null }))

const graph: LineageGraphDto = {
  rootVersionId: 'version-1',
  nodes: [{
    id: 'version-1', kind: 'version', label: 'CALLHOME raw · v1', namespace: 'speech', name: 'raw',
    summary: {}, data: { version: 'v1' }, status: null,
  }],
  edges: [], truncated: false, warnings: [],
}

describe('LineageGraph', () => {
  it('選択されたノードを表示範囲の中央へ寄せる', async () => {
    render(<LineageGraph graph={graph} selectedId="version-1" onSelect={vi.fn()} onClearSelection={vi.fn()} />)

    await waitFor(() => expect(fitView).toHaveBeenCalledWith(expect.objectContaining({
      nodes: [expect.objectContaining({ id: 'version-1' })],
      duration: 350,
    })))
  })
})
