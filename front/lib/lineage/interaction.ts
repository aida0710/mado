import type { LineageNodeSummary } from '../api/types'
import { LINEAGE_KIND_LABEL } from './labels'

export type LineageDirection = 'both' | 'upstream' | 'downstream'

interface NodeRef { id: string }
interface EdgeRef { id: string; source: string; target: string }

export interface LineagePathSelection {
  nodeIds: Set<string>
  edgeIds: Set<string>
}

export function traceLineagePath({ nodes, edges, selectedId, direction }: {
  nodes: NodeRef[]
  edges: EdgeRef[]
  selectedId: string
  direction: LineageDirection
}): LineagePathSelection {
  const available = new Set(nodes.map(node => node.id))
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  if (!available.has(selectedId)) return { nodeIds, edgeIds }

  nodeIds.add(selectedId)
  const queue = [selectedId]
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    for (const edge of edges) {
      if (direction !== 'downstream' && edge.target === current && available.has(edge.source)) {
        edgeIds.add(edge.id)
        if (!nodeIds.has(edge.source)) {
          nodeIds.add(edge.source)
          queue.push(edge.source)
        }
      }
      if (direction !== 'upstream' && edge.source === current && available.has(edge.target)) {
        edgeIds.add(edge.id)
        if (!nodeIds.has(edge.target)) {
          nodeIds.add(edge.target)
          queue.push(edge.target)
        }
      }
    }
  }
  return { nodeIds, edgeIds }
}

function searchableText(node: LineageNodeSummary): string {
  const data = node.data
  const registry = node.registry
  return [
    node.label,
    node.namespace,
    node.name,
    node.status,
    LINEAGE_KIND_LABEL[node.kind],
    registry?.displayName,
    registry?.datasetKey,
    ...(registry?.aliases ?? []),
    typeof data.version === 'string' ? data.version : null,
    typeof data.datasetName === 'string' ? data.datasetName : null,
    typeof data.jobName === 'string' ? data.jobName : null,
  ].filter((value): value is string => typeof value === 'string' && value !== '')
    .join('\n')
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
}

export function searchLineageNodes(nodes: LineageNodeSummary[], query: string): LineageNodeSummary[] {
  const terms = query.normalize('NFKC').trim().toLocaleLowerCase('ja-JP').split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  return nodes.filter(node => {
    if (node.kind === 'location') return false
    const text = searchableText(node)
    return terms.every(term => text.includes(term))
  })
}
