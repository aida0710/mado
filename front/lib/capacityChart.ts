import type { CapacityHistory } from './api/types'

type Point = CapacityHistory['points'][number]
export type CapacityChartPoint = {
  collectedAt: number
  totalBytes: number | null
  objectCount: number | null
}

/** 長い欠測区間へnull点を入れ、グラフが未計測期間を補間しないようにする。 */
export function capacityChartData(points: Point[], intervalSeconds: number): CapacityChartPoint[] {
  const rows: CapacityChartPoint[] = []
  for (let i = 0; i < points.length; i++) {
    const point = points[i]
    const previous = points[i - 1]
    if (previous && Date.parse(point.collectedAt) - Date.parse(previous.collectedAt) > intervalSeconds * 2.5 * 1000) {
      rows.push({
        collectedAt: (Date.parse(point.collectedAt) + Date.parse(previous.collectedAt)) / 2,
        totalBytes: null, objectCount: null,
      })
    }
    rows.push({
      collectedAt: Date.parse(point.collectedAt), totalBytes: point.totalBytes,
      objectCount: point.objectCount,
    })
  }
  return rows
}
