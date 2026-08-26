import { useMemo } from 'react'
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  type NodeMouseHandler,
} from '@xyflow/react'
import type { LineageGraph as LineageGraphDto, LineageNodeSummary } from '../../lib/api/types'
import { toFlowElements, type LineageFlowNode } from '../../lib/lineage/graphModel'
import { layoutLineage } from '../../lib/lineage/layout'
import { LineageNode } from './LineageNode'

const nodeTypes = { lineage: LineageNode }

interface Props {
  graph: LineageGraphDto
  selectedId: string
  onSelect: (node: LineageNodeSummary) => void
  onClearSelection: () => void
}

function Canvas({ graph, selectedId, onSelect, onClearSelection }: Props) {
  const { nodes, edges } = useMemo(() => {
    const elements = toFlowElements(graph)
    const layout = layoutLineage(elements.nodes, elements.edges)
    return {
      nodes: layout.nodes.map(node => ({ ...node, selected: node.id === selectedId })),
      edges: layout.edges,
    }
  }, [graph, selectedId])

  const byId = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes])
  const handleNodeClick: NodeMouseHandler<LineageFlowNode> = (_, node) => {
    const domain = byId.get(node.id)
    if (domain) onSelect(domain)
  }
  const graphKey = `${nodes.map(node => node.id).join('|')}::${edges.map(edge => edge.id).join('|')}`

  return (
    <div className="lineage-canvas" aria-label="Dataset lineage graph">
      <ReactFlow
        key={graphKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={onClearSelection}
        nodesConnectable={false}
        nodesDraggable={false}
        edgesFocusable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
        minZoom={0.18}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
        <Controls showInteractive={false} />
        {nodes.length > 8 && <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  )
}

export function LineageGraph(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}

export default LineageGraph
