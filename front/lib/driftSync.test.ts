import { describe, expect, it } from 'vitest'
import { computeDriftAdjustments } from './driftSync'

describe('computeDriftAdjustments', () => {
  it('threshold 以上ずれたトラックだけ矯正する', () => {
    expect(computeDriftAdjustments(10, [10.02, 10.2, 9.7])).toEqual([
      { index: 1, to: 10 },
      { index: 2, to: 10 },
    ])
  })
  it('null (終了済み) はスキップ', () => {
    expect(computeDriftAdjustments(10, [null, 12])).toEqual([{ index: 1, to: 10 }])
  })
  it('threshold は指定できる', () => {
    expect(computeDriftAdjustments(10, [10.2], 0.5)).toEqual([])
  })
})
