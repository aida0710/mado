import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { LineageNodeData } from '../../lib/lineage/graphModel'

const KIND_LABEL: Record<LineageNodeData['kind'], string> = {
  source: 'Source',
  dataset: 'Dataset',
  job: 'Job',
  version: 'Version',
  run: 'Run',
}
export function LineageNode({ data, selected }: NodeProps<Node<LineageNodeData, 'lineage'>>) {
  return (
    <div
      className="lineage-node-card"
      data-kind={data.kind}
      data-selected={selected || undefined}
      aria-label={`${KIND_LABEL[data.kind]}: ${data.title}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="lineage-node-card__kind">{KIND_LABEL[data.kind]}</span>
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
