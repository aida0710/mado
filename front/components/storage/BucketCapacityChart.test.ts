import { describe, expect, it } from 'vitest'
import { capacityChartData } from '../../lib/capacityChart'

describe('capacityChartData', () => {
  it('計測間隔の2.5倍を超える欠測区間はnullで線を切る', () => {
    const result = capacityChartData([
      { collectedAt: '2026-09-01T00:00:00Z', totalBytes: 100, objectCount: 1 },
      { collectedAt: '2026-09-04T00:00:01Z', totalBytes: 200, objectCount: 2 },
    ], 86400)
    expect(result).toHaveLength(3)
    expect(result[1]).toMatchObject({ totalBytes: null, objectCount: null })
  })

  it('通常間隔の観測点は補間点を入れない', () => {
    const result = capacityChartData([
      { collectedAt: '2026-09-01T00:00:00Z', totalBytes: 100, objectCount: 1 },
      { collectedAt: '2026-09-02T00:00:00Z', totalBytes: 200, objectCount: 2 },
    ], 86400)
    expect(result).toHaveLength(2)
  })
})
