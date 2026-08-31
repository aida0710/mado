import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  type NodeMouseHandler, useReactFlow,
} from '@xyflow/react'
import type { LineageGraph as LineageGraphDto, LineageNodeSummary } from '../../lib/api/types'
import { toFlowElements, type LineageFlowNode } from '../../lib/lineage/graphModel'
import {
  searchLineageNodes, traceLineagePath, type LineageDirection,
} from '../../lib/lineage/interaction'
import { LINEAGE_KIND_LABEL } from '../../lib/lineage/labels'
import { layoutLineage } from '../../lib/lineage/layout'
import { LineageNode } from './LineageNode'

const nodeTypes = { lineage: LineageNode }

interface Props {
  graph: LineageGraphDto
  selectedId: string
  onSelect: (node: LineageNodeSummary) => void
  onClearSelection: () => void
}

interface CanvasProps extends Props {
  direction: LineageDirection
}

const DIRECTIONS: Array<{ value: LineageDirection; label: string }> = [
  { value: 'both', label: '両方' },
  { value: 'upstream', label: '上流' },
  { value: 'downstream', label: '下流' },
]

function Canvas({ graph, selectedId, direction, onSelect, onClearSelection }: CanvasProps) {
  const { fitView } = useReactFlow<LineageFlowNode>()
  const focusedSelection = useRef('')
  const { nodes, edges } = useMemo(() => {
    const elements = toFlowElements(graph)
    const traced = selectedId
      ? traceLineagePath(elements.nodes, elements.edges, selectedId, direction)
      : null
    const activePath = traced && traced.nodeIds.size > 0 ? traced : null
    const layout = layoutLineage(
      elements.nodes.map(node => ({
        ...node,
        className: activePath
          ? activePath.nodeIds.has(node.id) ? 'lineage-flow-node--path' : 'lineage-flow-node--muted'
          : undefined,
      })),
      elements.edges.map(edge => ({
        ...edge,
        className: activePath
          ? activePath.edgeIds.has(edge.id) ? 'lineage-flow-edge--path' : 'lineage-flow-edge--muted'
          : undefined,
      })),
    )
    return {
      nodes: layout.nodes.map(node => ({ ...node, selected: node.id === selectedId })),
      edges: layout.edges,
    }
  }, [direction, graph, selectedId])

  const byId = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes])
  const handleNodeClick: NodeMouseHandler<LineageFlowNode> = (_, node) => {
    const domain = byId.get(node.id)
    if (domain) onSelect(domain)
  }
  const graphKey = `${nodes.map(node => node.id).join('|')}::${edges.map(edge => edge.id).join('|')}`

  useEffect(() => {
    if (!selectedId) {
      focusedSelection.current = ''
      return
    }
    const selectedNodes = nodes.filter(node => node.id === selectedId)
    const focusKey = `${graphKey}::${selectedId}`
    if (selectedNodes.length === 0 || focusedSelection.current === focusKey) return
    focusedSelection.current = focusKey
    const frame = window.requestAnimationFrame(() => {
      void fitView({ nodes: selectedNodes, padding: 1.1, minZoom: 0.9, maxZoom: 1.35, duration: 350 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [fitView, graphKey, nodes, selectedId])

  return (
    <div className="lineage-canvas" aria-label="データの流れグラフ">
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
  const [direction, setDirection] = useState<LineageDirection>('both')
  const [query, setQuery] = useState('')
  const results = useMemo(() => searchLineageNodes(props.graph.nodes, query), [props.graph.nodes, query])
  const visibleResults = results.slice(0, 8)
  const searching = query.trim() !== ''

  return (
    <div className="lineage-graph">
      <div className="lineage-graph__tools">
        <div className="lineage-graph__search">
          <label>
            <span>グラフ内検索</span>
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="データセット名、処理名…"
              autoComplete="off"
            />
          </label>
          {searching && (
            <div className="lineage-graph__search-results">
              {visibleResults.length === 0 ? (
                <p>該当する項目はありません。</p>
              ) : (
                <ul>
                  {visibleResults.map(node => (
                    <li key={node.id}>
                      <button type="button" onClick={() => { props.onSelect(node); setQuery('') }}>
                        <strong>{node.label}</strong>
                        <span>{LINEAGE_KIND_LABEL[node.kind]}{node.namespace ? ` · ${node.namespace}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {results.length > visibleResults.length && <small>ほか{results.length - visibleResults.length}件</small>}
            </div>
          )}
        </div>
        <div className="lineage-graph__direction-picker">
          <span>たどる方向</span>
          <div className="lineage-graph__directions" role="group" aria-label="選択項目から辿る方向">
            {DIRECTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                data-active={direction === option.value || undefined}
                aria-pressed={direction === option.value}
                onClick={() => setDirection(option.value)}
              >{option.label}</button>
            ))}
          </div>
        </div>
      </div>
      <ReactFlowProvider><Canvas {...props} direction={direction} /></ReactFlowProvider>
    </div>
  )
}

export default LineageGraph
