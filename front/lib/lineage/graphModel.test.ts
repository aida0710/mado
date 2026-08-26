import { describe, expect, it } from 'vitest'
import type { LineageGraph } from '../api/types'
import { toFlowElements } from './graphModel'
import { layoutLineage, LINEAGE_NODE_HEIGHT, LINEAGE_NODE_WIDTH } from './layout'

const graph: LineageGraph = {
  nodes: [
    { id: 'd:raw', kind: 'dataset', label: 'raw', namespace: 'speech', summary: {}, data: {}, registry: null },
    { id: 'j:clean', kind: 'job', label: 'clean', namespace: 'speech', summary: {}, data: {}, status: 'COMPLETE' },
    { id: 'd:out', kind: 'dataset', label: 'curated', namespace: 'speech', summary: {}, data: {}, registry: null },
    { id: 'loc:1', kind: 'location', label: 's3://bucket', summary: {}, data: {} },
  ],
  edges: [
    { id: 'e1', source: 'd:raw', target: 'j:clean', kind: 'input' },
    { id: 'e2', source: 'j:clean', target: 'd:out', kind: 'output' },
    { id: 'e3', source: 'd:out', target: 'loc:1', kind: 'stored_at' },
  ],
  generatedAt: '2026-01-01T00:00:00Z', truncated: false, warnings: [],
}

describe('lineage graph model', () => {
  it('turns domain nodes into flow nodes and keeps opaque IDs', () => {
    const result = toFlowElements(graph)
    expect(result.nodes.map(node => node.id)).toEqual(['d:raw', 'j:clean', 'd:out'])
    expect(result.edges.map(edge => edge.id)).toEqual(['e1', 'e2'])
    expect(result.nodes[1].data.status).toBe('COMPLETE')
  })

  it('does not expose storage locations as canvas nodes', () => {
    const result = toFlowElements(graph)
    expect(result.nodes.map(node => node.id)).not.toContain('loc:1')
    expect(result.edges.some(edge => edge.target === 'loc:1')).toBe(false)
  })

  it('lays a DAG left to right without mutating domain-derived nodes', () => {
    const elements = toFlowElements(graph)
    const before = structuredClone(elements.nodes)
    const laidOut = layoutLineage(elements.nodes, elements.edges)
    expect(elements.nodes).toEqual(before)
    expect(laidOut.nodes[0].position.x).toBeLessThan(laidOut.nodes[1].position.x)
    expect(laidOut.nodes[1].position.x).toBeLessThan(laidOut.nodes[2].position.x)
    expect(laidOut.nodes[0]).toMatchObject({ width: LINEAGE_NODE_WIDTH, height: LINEAGE_NODE_HEIGHT })
  })

  it('returns finite positions even when the input contains a cycle', () => {
    const elements = toFlowElements({
      ...graph,
      edges: [...graph.edges.slice(0, 2), { id: 'back', source: 'd:out', target: 'd:raw', kind: 'lineage' }],
    })
    const laidOut = layoutLineage(elements.nodes, elements.edges)
    for (const node of laidOut.nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true)
      expect(Number.isFinite(node.position.y)).toBe(true)
    }
  })
})
