import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { LineageGraph, LineageNodeKind, LineageNodeSummary } from '../api/types'
import { lineageStatusLabel } from './labels'

export type VisibleLineageNodeKind = Exclude<LineageNodeKind, 'location'>

export type LineageNodeData = Record<string, unknown> & {
  domain: LineageNodeSummary
  kind: VisibleLineageNodeKind
  title: string
  subtitle: string | null
  status: string | null
  meta: string | null
}

export type LineageFlowNode = Node<LineageNodeData, 'lineage'>

const VISIBLE_KINDS = new Set<LineageNodeKind>(['source', 'dataset', 'job', 'version', 'run'])

function stringData(node: LineageNodeSummary, key: string): string | null {
  const value = node.data[key] ?? node.summary[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function subtitleOf(node: LineageNodeSummary): string | null {
  if (node.namespace) return node.name && node.name !== node.label
    ? `${node.namespace} / ${node.name}`
    : node.namespace
  return stringData(node, 'datasetName') ?? stringData(node, 'jobName')
}

function statusOf(node: LineageNodeSummary): string | null {
  return lineageStatusLabel(node.status
    ?? node.latestRun?.state
    ?? stringData(node, 'status')
    ?? stringData(node, 'state'))
}

function metaOf(node: LineageNodeSummary): string | null {
  if (node.kind === 'dataset' || node.kind === 'source') {
    const versions = node.registry?.versionCount
    if (versions != null) return `バージョン ${versions}件`
    return node.completeness === 'unregistered' ? '台帳未登録' : null
  }
  if (node.kind === 'version') return stringData(node, 'version')
  return null
}

export function toFlowElements(graph: LineageGraph): {
  nodes: LineageFlowNode[]
  edges: Edge[]
} {
  const visible = graph.nodes.filter(
    (node): node is LineageNodeSummary & { kind: VisibleLineageNodeKind } => VISIBLE_KINDS.has(node.kind),
  )
  const ids = new Set(visible.map(node => node.id))
  return {
    nodes: visible.map(node => ({
      id: node.id,
      type: 'lineage',
      position: { x: 0, y: 0 },
      data: {
        domain: node,
        kind: node.kind,
        title: node.label,
        subtitle: subtitleOf(node),
        status: statusOf(node),
        meta: metaOf(node),
      },
    })),
    edges: graph.edges
      .filter(edge => ids.has(edge.source) && ids.has(edge.target))
      .map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15 },
        data: { kind: edge.kind },
      })),
  }
}
