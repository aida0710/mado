import { describe, expect, it } from 'vitest'
import { computeDriftAdjustments, masterTimeOf } from './driftSync'

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

describe('masterTimeOf', () => {
  it('非終了トラックの currentTime の最大値を返す', () => {
    expect(masterTimeOf([1.0, 3.2, 2.5])).toBe(3.2)
  })
  it('終了トラック (null) は無視する', () => {
    // 短いトラックが ended=null。長い方が進み続けてマスターになる
    expect(masterTimeOf([null, 2.7])).toBe(2.7)
  })
  it('全トラック終了 (全 null) なら null', () => {
    expect(masterTimeOf([null, null])).toBeNull()
  })
  it('空配列なら null', () => {
    expect(masterTimeOf([])).toBeNull()
  })
})
