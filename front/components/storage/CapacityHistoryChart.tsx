import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts'
import type { CapacityPoint } from '../../lib/api/types'
import { capacityChartData, type CapacityChartPoint } from '../../lib/capacityChart'
import { fmtCapacityBytes } from '../../lib/format'
import { useDocumentTheme } from '../../lib/useDocumentTheme'

// 軸と tooltip は幅が狭いので、表や見出しより 1 桁少なく丸める。
const CHART_FRACTION_DIGITS = 1

// recharts は色を SVG の属性に書くので、CSS の変数がテーマで切り替わっても自分では
// 追従しない。描くたびに今のテーマの値を読み、テーマが変わったら描き直す。
// 値を読めない環境 (テスト) では変数の参照のまま渡す。
function readChartColors() {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string) => style.getPropertyValue(name).trim() || `var(${name})`
  return {
    grid: read('--border'),
    axis: read('--border-strong'),
    tick: read('--muted'),
    line: read('--accent'),
    limit: read('--error'),
    latest: read('--border-strong'),
    background: read('--background'),
  }
}

function CapacityTooltip({ active, payload, label }: {
  active?: boolean
  payload?: Array<{ payload?: CapacityChartPoint }>
  label?: number | string
}) {
  const point = payload?.[0]?.payload
  if (!active || !point || point.totalBytes == null) return null
  return (
    <div className="capacity-tooltip">
      <p className="muted">{new Date(Number(label)).toLocaleString('ja-JP')}</p>
      <p className="capacity-tooltip-value">{fmtCapacityBytes(point.totalBytes, CHART_FRACTION_DIGITS)}</p>
      <p className="muted">{point.objectCount?.toLocaleString('ja-JP')} objects</p>
    </div>
  )
}

/** バケット、またはバケット直下のディレクトリの容量推移。label は読み上げと表の見出しに使う。 */
export default function CapacityHistoryChart({ points, intervalSeconds, capacityBytes, label }: {
  points: CapacityPoint[]
  intervalSeconds: number
  capacityBytes: number | null
  label: string
}) {
  // テーマが切り替わったら描き直す (下で色を読み直す)。
  useDocumentTheme()
  const colors = readChartColors()
  const data = capacityChartData(points, intervalSeconds)
  const latest = points.at(-1)?.totalBytes
  return (
    <div>
      <div className="capacity-chart-plot" role="img" aria-label={`${label}の容量推移グラフ`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 2, left: 2 }} accessibilityLayer>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis
              dataKey="collectedAt"
              type="number" scale="time" domain={['dataMin', 'dataMax']}
              tickFormatter={value => new Date(Number(value)).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}
              tick={{ fontSize: 11, fill: colors.tick }}
              axisLine={{ stroke: colors.axis }} tickLine={false}
            />
            <YAxis
              tickFormatter={value => fmtCapacityBytes(Number(value), CHART_FRACTION_DIGITS)}
              width={70} tick={{ fontSize: 10, fill: colors.tick }}
              axisLine={false} tickLine={false}
            />
            <Tooltip content={<CapacityTooltip />} cursor={{ stroke: colors.axis }} />
            {capacityBytes !== null
              ? <ReferenceLine y={capacityBytes} stroke={colors.limit} strokeDasharray="4 4" label="上限" />
              : latest !== undefined && <ReferenceLine y={latest} stroke={colors.latest} strokeDasharray="3 4" />}
            <Line
              type="linear" dataKey="totalBytes" name="容量" connectNulls={false} isAnimationActive={false}
              stroke={colors.line} strokeWidth={1.75} dot={false}
              activeDot={{ r: 3.5, fill: colors.line, stroke: colors.background }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{label}の容量の履歴</caption>
        <thead><tr><th>取得日時</th><th>容量</th><th>オブジェクト数</th></tr></thead>
        <tbody>{points.map(point => (
          <tr key={point.collectedAt}>
            <td>{new Date(point.collectedAt).toLocaleString('ja-JP')}</td>
            <td>{fmtCapacityBytes(point.totalBytes, CHART_FRACTION_DIGITS)}</td>
            <td>{point.objectCount.toLocaleString('ja-JP')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}
