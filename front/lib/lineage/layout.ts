import dagre from '@dagrejs/dagre'
import { Position, type Edge } from '@xyflow/react'
import type { LineageFlowNode } from './graphModel'

export const LINEAGE_NODE_WIDTH = 224
export const LINEAGE_NODE_HEIGHT = 78

export function layoutLineage(
  nodes: LineageFlowNode[],
  edges: Edge[],
): { nodes: LineageFlowNode[]; edges: Edge[] } {
  if (nodes.length === 0) return { nodes: [], edges: [...edges] }

  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'LR', nodesep: 30, ranksep: 92, marginx: 24, marginy: 24 })
  for (const node of nodes) {
    graph.setNode(node.id, { width: LINEAGE_NODE_WIDTH, height: LINEAGE_NODE_HEIGHT })
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)

  return {
    nodes: nodes.map(node => {
      const position = graph.node(node.id)
      return {
        ...node,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        width: LINEAGE_NODE_WIDTH,
        height: LINEAGE_NODE_HEIGHT,
        position: {
          x: position.x - LINEAGE_NODE_WIDTH / 2,
          y: position.y - LINEAGE_NODE_HEIGHT / 2,
        },
      }
    }),
    edges: edges.map(edge => ({ ...edge })),
  }
}
