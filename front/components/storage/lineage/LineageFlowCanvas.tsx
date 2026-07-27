// 家系図の flow キャンバス。React Flow + dagre の自動レイアウトで、
// パン / ズーム / ドラッグ接続ができる形にする。
//
// もとは世代ごとの列にボタンを並べるだけで、エッジを 1 本も描いていなかった。
// 1 世代に複数ノードがあると「どれがどれの親か」が画面上で判別できず、
// これが「直感的でない」最大の原因だった。
//
// ノード位置は保存しない。開くたびに dagre で組み直す (左→右の DAG)。
// ドラッグでその場は動かせるが、リロードで元に戻る。位置を保存すると
// テーブルが増え、かつ「人によって配置が違う」問題が出るため。
//
// このモジュールは React Flow (重い) を抱えるので、呼び出し側は lazy で読む。

import { useCallback, useMemo } from 'react'
import dagre from '@dagrejs/dagre'
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider,
  Handle, Position,
  type Connection, type Edge, type Node, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { nodeKey, nodeKind, type LineageNode } from '../../../lib/lineageGraph'

const KIND_ICON: Record<'bucket' | 'directory' | 'file', string> = {
  bucket: '📦', directory: '📁', file: '📄',
}

// dagre に渡す実寸。ノードの見た目 (CSS) と揃えないと線がずれる。
const NODE_W = 240
const NODE_H = 52

export interface FlowEdge {
  /** DB の storage_lineage_links.id。バケット単位に畳んだ表示では複数束ねるので配列。 */
  ids: number[]
  parent: LineageNode
  child: LineageNode
}

interface Props {
  nodes: LineageNode[]
  edges: FlowEdge[]
  /** 「現在地」スコープでの中心。無い場合もある (全て / バケット単位)。 */
  center?: LineageNode | null
  onNodeClick: (node: LineageNode) => void
  onNodeDoubleClick: (node: LineageNode) => void
  /** エッジをクリックしたとき。束ねている id をすべて渡す。 */
  onEdgeClick: (ids: number[]) => void
  /** ハンドルからドラッグして繋いだとき。閉路になる組は呼ばれない。 */
  onConnect: (parent: LineageNode, child: LineageNode) => void
  /** 閉路になる接続を試みたとき (UI 側でメッセージを出す用)。 */
  onRejectCycle: () => void
  /** parent → child が閉路になるか。lineageGraph.wouldCreateCycle を渡す。 */
  isCycle: (parent: LineageNode, child: LineageNode) => boolean
}

type NodeData = {
  /** 主役。パス (バケットノードならバケット名)。区別に効くのはこちら。 */
  primary: string
  /** 補助。バケット名 (バケットノードでは出さない)。 */
  secondary: string | null
  /** title 属性に出す全体。 */
  full: string
  kind: 'bucket' | 'directory' | 'file'
  emphasize: boolean
}

// ノードの見た目。左右にハンドルを置き、右 (source) から左 (target) へ繋ぐと
// 「親 → 子」になる — dagre の LR レイアウトと向きが一致する。
function LineageFlowNode({ data }: NodeProps) {
  const d = data as NodeData
  return (
    <div className="lineage-flow-node" data-emphasize={d.emphasize || undefined} title={d.full}>
      <Handle type="target" position={Position.Left} />
      <span aria-hidden className="lineage-flow-node__icon">{KIND_ICON[d.kind]}</span>
      <span className="lineage-flow-node__text">
        {/* パスは末尾ほど区別に効く (in/ mid/ out/)。溢れたら先頭を省略する。 */}
        <span className="lineage-flow-node__primary">{d.primary}</span>
        {d.secondary && <span className="lineage-flow-node__secondary">{d.secondary}</span>}
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { lineage: LineageFlowNode }

function labelOf(n: LineageNode): string {
  return n.path === '' ? n.bucket : `${n.bucket}/${n.path}`
}

// dagre で左→右に配置する。React Flow は左上原点なので中心座標から引く。
function layout(nodes: LineageNode[], edges: FlowEdge[], center?: LineageNode | null) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 90 })

  for (const n of nodes) g.setNode(nodeKey(n), { width: NODE_W, height: NODE_H })
  for (const e of edges) g.setEdge(nodeKey(e.parent), nodeKey(e.child))
  dagre.layout(g)

  const rfNodes: Node[] = nodes.map(n => {
    const key = nodeKey(n)
    const pos = g.node(key)
    return {
      id: key,
      type: 'lineage',
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      // 実寸を明示する。ミニマップは渡したノード側の width/height を見るので
      // (measured ではなく userNode)、省略すると nodeHasDimensions を通らず
      // ノードの影が 1 つも描かれない。CSS の .lineage-flow-node と同値。
      width: NODE_W,
      height: NODE_H,
      data: {
        primary: n.path === '' ? n.bucket : n.path,
        secondary: n.path === '' ? null : n.bucket,
        full: labelOf(n),
        kind: nodeKind(n.path),
        emphasize: !!center && nodeKey(center) === key,
      } satisfies NodeData,
    }
  })

  const rfEdges: Edge[] = edges.map(e => ({
    id: `${nodeKey(e.parent)}->${nodeKey(e.child)}`,
    source: nodeKey(e.parent),
    target: nodeKey(e.child),
    animated: false,
    // 「クリックで解除」に気づけるよう当たり判定を広めに取る。
    interactionWidth: 16,
  }))

  return { rfNodes, rfEdges }
}

function Inner({
  nodes, edges, center, onNodeClick, onNodeDoubleClick, onEdgeClick, onConnect, onRejectCycle, isCycle,
}: Props) {
  const { rfNodes, rfEdges } = useMemo(() => layout(nodes, edges, center), [nodes, edges, center])

  // id (bucket|path) から元のノードへ戻すための索引。
  const byKey = useMemo(() => {
    const m = new Map<string, LineageNode>()
    for (const n of nodes) m.set(nodeKey(n), n)
    return m
  }, [nodes])

  const edgeIdsByKey = useMemo(() => {
    const m = new Map<string, number[]>()
    for (const e of edges) m.set(`${nodeKey(e.parent)}->${nodeKey(e.child)}`, e.ids)
    return m
  }, [edges])

  const handleConnect = useCallback((c: Connection) => {
    const parent = c.source ? byKey.get(c.source) : undefined
    const child = c.target ? byKey.get(c.target) : undefined
    if (!parent || !child) return
    if (isCycle(parent, child)) {
      onRejectCycle()
      return
    }
    onConnect(parent, child)
  }, [byKey, isCycle, onConnect, onRejectCycle])

  // ドラッグ中に「繋いでよい相手か」を判定して、閉路になる組はドロップさせない。
  const isValidConnection = useCallback((c: Connection | Edge) => {
    const source = 'source' in c ? c.source : null
    const target = 'target' in c ? c.target : null
    const parent = source ? byKey.get(source) : undefined
    const child = target ? byKey.get(target) : undefined
    if (!parent || !child) return false
    return !isCycle(parent, child)
  }, [byKey, isCycle])

  return (
    <div className="lineage-flow">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => {
          const node = byKey.get(n.id)
          if (node) onNodeClick(node)
        }}
        onNodeDoubleClick={(_, n) => {
          const node = byKey.get(n.id)
          if (node) onNodeDoubleClick(node)
        }}
        onEdgeClick={(_, e) => {
          const ids = edgeIdsByKey.get(e.id)
          if (ids && ids.length > 0) onEdgeClick(ids)
        }}
        fitView
        // 1 ノードだけのときに極端に拡大されないよう上限を締める。
        fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  )
}

export function LineageFlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  )
}

export default LineageFlowCanvas
