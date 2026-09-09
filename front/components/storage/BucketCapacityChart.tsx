import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { CapacityBucketHistory } from '../../lib/api/types'
import { capacityChartData, type CapacityChartPoint } from '../../lib/capacityChart'

type Point = CapacityBucketHistory['points'][number]

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toLocaleString('ja-JP', { maximumFractionDigits: 1 })} ${units[unit]}`
}

function CapacityTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ payload?: CapacityChartPoint }>
  label?: number | string
}) {
  const point = payload?.[0]?.payload
  if (!active || !point || point.totalBytes == null) return null
  return (
    <div className="border border-rule-strong bg-paper px-3 py-2 text-[12px] shadow-sm">
      <p className="text-ink-7">{new Date(Number(label)).toLocaleString('ja-JP')}</p>
      <p className="mt-1 font-semibold">{formatBytes(point.totalBytes)}</p>
      <p className="text-ink-7">{point.objectCount?.toLocaleString('ja-JP')} objects</p>
    </div>
  )
}

export default function BucketCapacityChart({ points, intervalSeconds, capacityBytes, label }: {
  points: Point[]
  intervalSeconds: number
  capacityBytes: number | null
  label?: string
}) {
  const data = capacityChartData(points, intervalSeconds)
  const latest = points.at(-1)?.totalBytes
  return (
    <div>
      <div className="h-[120px] w-full" role="img" aria-label={`${label ?? 'バケット'}の容量推移グラフ`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 2, left: 2 }} accessibilityLayer>
            <CartesianGrid stroke="var(--rule)" vertical={false} />
            <XAxis
              dataKey="collectedAt"
              type="number" scale="time" domain={['dataMin', 'dataMax']}
              tickFormatter={value => new Date(Number(value)).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}
              tick={{ fontSize: 11, fill: 'var(--ink-7)' }}
              axisLine={{ stroke: 'var(--rule-strong)' }} tickLine={false}
            />
            <YAxis
              tickFormatter={value => formatBytes(Number(value))}
              width={70} tick={{ fontSize: 10, fill: 'var(--ink-7)' }}
              axisLine={false} tickLine={false}
            />
            <Tooltip content={<CapacityTooltip />} />
            {capacityBytes !== null
              ? <ReferenceLine y={capacityBytes} stroke="var(--danger)" strokeDasharray="4 4" label="上限" />
              : latest !== undefined && <ReferenceLine y={latest} stroke="var(--ink-3)" strokeDasharray="3 4" />}
            <Line
              type="linear" dataKey="totalBytes" name="容量" connectNulls={false} isAnimationActive={false}
              stroke="var(--ink-12)" strokeWidth={1.75} dot={false} activeDot={{ r: 3.5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>バケット容量の履歴</caption>
        <thead><tr><th>取得日時</th><th>容量</th><th>オブジェクト数</th></tr></thead>
        <tbody>{points.map(point => (
          <tr key={point.collectedAt}>
            <td>{new Date(point.collectedAt).toLocaleString('ja-JP')}</td>
            <td>{formatBytes(point.totalBytes)}</td>
            <td>{point.objectCount.toLocaleString('ja-JP')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}
