import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { LineageNodeData } from '../../lib/lineage/graphModel'
import { LINEAGE_KIND_LABEL } from '../../lib/lineage/labels'
export function LineageNode({ data, selected }: NodeProps<Node<LineageNodeData, 'lineage'>>) {
  return (
    <div
      className="lineage-node-card"
      data-kind={data.kind}
      data-selected={selected || undefined}
      aria-label={`${LINEAGE_KIND_LABEL[data.kind]}: ${data.title}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="lineage-node-card__kind">{LINEAGE_KIND_LABEL[data.kind]}</span>
      <strong className="lineage-node-card__title" title={data.title}>{data.title}</strong>
      {data.subtitle && <span className="lineage-node-card__subtitle" title={data.subtitle}>{data.subtitle}</span>}
      <span className="lineage-node-card__foot">
        {data.status && <span className="lineage-node-card__status">{data.status}</span>}
        {data.meta && <span>{data.meta}</span>}
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  )
}
