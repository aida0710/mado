// 家系図ビューでノードをクリックすると開く小さいポップアップ。
// bucket/directory は README 冒頭、file は既存のスニッフ済みプレビューを
// 縮小埋め込みする。加えて、このノード自身が当事者になっている直接の親子を
// 列挙し、行ごとに「解除」できるようにする — 「全て」「バケット単位」モードには
// 単一の中心ノードが無く、単純な「リンク解除」ボタン1つでは対象が一意に
// 決まらないため (front/lib/lineageGraph.ts の edgesTouching 相当を参照)。

import { classify } from '../../../lib/api/mime'
import type { LineageLink } from '../../../lib/api/types'
import { directChildren, directParents, nodeKind, type LineageNode } from '../../../lib/lineageGraph'
import { PreviewImage } from '../../PreviewImage'
import { PreviewText } from '../../PreviewText'
import { ReadmeView } from '../../ReadmeView'

interface Props {
  connId: string
  node: LineageNode
  edges: LineageLink[]
  onNavigate: (node: LineageNode) => void
  onUnlink: (edgeId: number) => void
  onClose: () => void
}

const KIND_ICON: Record<'bucket' | 'directory' | 'file', string> = {
  bucket: '📦', directory: '📁', file: '📄',
}

function NeighbourRow(
  { label, edgeId, onUnlink }: { label: string; edgeId: number; onUnlink: (id: number) => void },
) {
  return (
    <li className="lineage-popup__neighbour">
      <span className="lineage-popup__neighbour-label">{label}</span>
      <button type="button" className="ghost" onClick={() => onUnlink(edgeId)}>
        解除
      </button>
    </li>
  )
}

export function LineageNodePopup({ connId, node, edges, onNavigate, onUnlink, onClose }: Props) {
  const kind = nodeKind(node.path)
  const parents = directParents(edges, node)
  const children = directChildren(edges, node)
  const label = node.path === '' ? node.bucket : `${node.bucket}/${node.path}`

  return (
    <div className="modal-backdrop modal-backdrop--lineage-node" role="presentation">
      <button
        type="button"
        className="modal-backdrop__close-overlay"
        onClick={onClose}
        aria-label="モーダルを閉じる"
        tabIndex={-1}
      />
      <div className="modal modal--lineage-node" role="dialog" aria-modal="true" aria-labelledby="lineage-node-title">
        <header className="lineage-popup__head">
          <p id="lineage-node-title" className="lineage-popup__title">
            <span aria-hidden>{KIND_ICON[kind]}</span> {label}
          </p>
          <button type="button" className="ghost" onClick={onClose} aria-label="閉じる">✕</button>
        </header>

        <div className="lineage-popup__body">
          {kind !== 'file' ? (
            <ReadmeView connId={connId} bucket={node.bucket} prefix={node.path} />
          ) : classify(node.path) === 'image' ? (
            <PreviewImage connId={connId} bucket={node.bucket} k={node.path} />
          ) : classify(node.path) === 'unknown' ? (
            <PreviewText connId={connId} bucket={node.bucket} k={node.path} />
          ) : (
            <p className="lineage-popup__unsupported">
              このファイル種別はここでは表示できません。「このパスへ移動」から開いてください。
            </p>
          )}
        </div>

        {(parents.length > 0 || children.length > 0) && (
          <div className="lineage-popup__neighbours">
            {parents.length > 0 && (
              <>
                <p className="label">↑ 親</p>
                <ul className="lineage-popup__neighbour-list">
                  {parents.map(e => (
                    <NeighbourRow key={e.id} edgeId={e.id} onUnlink={onUnlink} label={`${e.parentBucket}/${e.parentPath}`} />
                  ))}
                </ul>
              </>
            )}
            {children.length > 0 && (
              <>
                <p className="label">↓ 子</p>
                <ul className="lineage-popup__neighbour-list">
                  {children.map(e => (
                    <NeighbourRow key={e.id} edgeId={e.id} onUnlink={onUnlink} label={`${e.childBucket}/${e.childPath}`} />
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={() => onNavigate(node)}>このパスへ移動</button>
        </div>
      </div>
    </div>
  )
}
