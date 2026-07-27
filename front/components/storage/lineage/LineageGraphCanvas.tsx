// 家系図のグラフ描画 (プレゼンテーショナル)。データの取得・レイアウト計算は
// LineageView が front/lib/lineageGraph.ts を使って行い、ここは受け取った
// レイアウトを並べるだけ。
//
// 「現在地」モードは中心ノードを持つので世代ごとの列で描く。
// 「全て」「バケット単位」モードは単一の中心が無いので、親→子のエッジを
// フラットに列挙する (登録数が増えても実装が複雑にならないシンプルな形)。

import { nodeKey, nodeKind, type LineageNode } from '../../../lib/lineageGraph'

export interface CurrentLayout {
  scope: 'current'
  center: LineageNode
  ancestorGenerations: LineageNode[][]
  descendantGenerations: LineageNode[][]
}

export interface EdgeListLayout {
  scope: 'all' | 'bucket'
  edges: Array<{ id: string; parent: LineageNode; child: LineageNode }>
}

export type LineageLayout = CurrentLayout | EdgeListLayout

interface Props {
  layout: LineageLayout
  onNodeClick: (node: LineageNode) => void
}

const KIND_ICON: Record<'bucket' | 'directory' | 'file', string> = {
  bucket: '📦', directory: '📁', file: '📄',
}

function NodeBox({ node, onClick, emphasize }: { node: LineageNode; onClick: () => void; emphasize?: boolean }) {
  const kind = nodeKind(node.path)
  const label = node.path === '' ? node.bucket : `${node.bucket}/${node.path}`
  return (
    <button
      type="button"
      className="lineage-node"
      data-emphasize={emphasize || undefined}
      onClick={onClick}
      title={label}
    >
      {KIND_ICON[kind]} {label}
    </button>
  )
}

const EMPTY_MESSAGE = '登録されたリンクがありません。'

export function LineageGraphCanvas({ layout, onNodeClick }: Props) {
  if (layout.scope === 'current') {
    const ancestorCols = [...layout.ancestorGenerations].reverse()
    const isEmpty = ancestorCols.length === 0 && layout.descendantGenerations.length === 0
    return (
      <div className="lineage-canvas">
        {isEmpty ? (
          <p className="lineage-canvas__empty">{EMPTY_MESSAGE}</p>
        ) : (
          <>
            {ancestorCols.map((col, i) => (
              <div className="lineage-column" key={`a${i}`}>
                {col.map(n => (
                  <NodeBox key={nodeKey(n)} node={n} onClick={() => onNodeClick(n)} />
                ))}
              </div>
            ))}
            <div className="lineage-column lineage-column--center">
              <NodeBox node={layout.center} onClick={() => onNodeClick(layout.center)} emphasize />
            </div>
            {layout.descendantGenerations.map((col, i) => (
              <div className="lineage-column" key={`d${i}`}>
                {col.map(n => (
                  <NodeBox key={nodeKey(n)} node={n} onClick={() => onNodeClick(n)} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    )
  }

  if (layout.edges.length === 0) {
    return <p className="lineage-canvas__empty">{EMPTY_MESSAGE}</p>
  }
  return (
    <ul className="lineage-edge-list">
      {layout.edges.map(e => (
        <li key={e.id} className="lineage-edge-row">
          <NodeBox node={e.parent} onClick={() => onNodeClick(e.parent)} />
          <span aria-hidden className="lineage-edge-arrow">→</span>
          <NodeBox node={e.child} onClick={() => onNodeClick(e.child)} />
        </li>
      ))}
    </ul>
  )
}
