import { describe, expect, it } from 'vitest'
import type { LineageNodeSummary } from '../api/types'
import { searchLineageNodes, traceLineagePath } from './interaction'

const nodes = [{ id: 'source' }, { id: 'raw' }, { id: 'run' }, { id: 'output' }, { id: 'other' }]
const edges = [
  { id: 'e1', source: 'source', target: 'raw' },
  { id: 'e2', source: 'raw', target: 'run' },
  { id: 'e3', source: 'run', target: 'output' },
]

describe('lineage interaction', () => {
  it('選択項目から上流・下流・両方向の経路だけを辿る', () => {
    expect([...traceLineagePath({ nodes, edges, selectedId: 'run', direction: 'upstream' }).nodeIds]).toEqual(['run', 'raw', 'source'])
    expect([...traceLineagePath({ nodes, edges, selectedId: 'run', direction: 'downstream' }).nodeIds]).toEqual(['run', 'output'])
    expect(traceLineagePath({ nodes, edges, selectedId: 'run', direction: 'both' }).nodeIds).toEqual(new Set(['source', 'raw', 'run', 'output']))
    expect(traceLineagePath({ nodes, edges, selectedId: 'run', direction: 'both' }).edgeIds).toEqual(new Set(['e1', 'e2', 'e3']))
  })

  it('循環があっても停止し、存在しない起点では空集合を返す', () => {
    const cyclic = [...edges, { id: 'back', source: 'output', target: 'raw' }]
    expect(traceLineagePath({ nodes, edges: cyclic, selectedId: 'run', direction: 'both' }).nodeIds).toEqual(new Set(['source', 'raw', 'run', 'output']))
    expect(traceLineagePath({ nodes, edges: cyclic, selectedId: 'missing', direction: 'both' }).nodeIds.size).toBe(0)
  })

  it('表示名・技術名・種類を空白区切りで検索する', () => {
    const graphNodes: LineageNodeSummary[] = [
      {
        id: 'raw', kind: 'dataset', label: 'Fisher Sidon', namespace: 'mdx-inventory', name: 'dataset/fisher/raw',
        summary: {}, data: {}, registry: {
          kind: 'dataset', datasetId: 'd1', datasetKey: 'fisher/raw', namespace: 'mdx-inventory',
          name: 'dataset/fisher/raw', displayName: 'Fisher Sidon', aliases: ['Fisher raw'], description: null,
          mediaType: 'audio', owner: null, currentVersionId: 'v1', versionCount: 1,
        },
      },
      { id: 'run', kind: 'run', label: 'moss-nano codec変換', summary: {}, data: { jobName: 'encode-moss' } },
    ]

    expect(searchLineageNodes(graphNodes, 'Fisher データセット').map(node => node.id)).toEqual(['raw'])
    expect(searchLineageNodes(graphNodes, 'MOSS encode').map(node => node.id)).toEqual(['run'])
    expect(searchLineageNodes(graphNodes, '   ')).toEqual([])
  })
})
