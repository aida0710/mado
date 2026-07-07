import { describe, expect, it } from 'vitest'
import { PeakAccumulator, PEAK_BUCKETS } from './media-peaks.js'

describe('PeakAccumulator', () => {
  it('少サンプルでも finish で指定バケット数以下の peaks を返す', () => {
    const acc = new PeakAccumulator()
    acc.push(new Float32Array([0.5, -0.5, 0.25]))
    const { peaks, totalSamples } = acc.finish(4)
    expect(totalSamples).toBe(3)
    expect(peaks.length).toBeLessThanOrEqual(4)
    // 全体の min/max が保存されている
    const min = Math.min(...peaks.map(p => p[0]))
    const max = Math.max(...peaks.map(p => p[1]))
    expect(min).toBeCloseTo(-0.5)
    expect(max).toBeCloseTo(0.5)
  })

  it('大量サンプルでも内部ペア数が上限内に収まり finish は既定 2000 バケット', () => {
    const acc = new PeakAccumulator({ windowSamples: 16, maxPairs: 64 })
    const chunk = new Float32Array(1024).fill(0.1)
    chunk[0] = -1
    chunk[1023] = 1
    for (let i = 0; i < 100; i++) acc.push(chunk)
    const { peaks, totalSamples } = acc.finish()
    expect(totalSamples).toBe(1024 * 100)
    expect(peaks.length).toBeLessThanOrEqual(PEAK_BUCKETS)
    expect(Math.min(...peaks.map(p => p[0]))).toBeCloseTo(-1)
    expect(Math.max(...peaks.map(p => p[1]))).toBeCloseTo(1)

    // halve() が機能していれば内部ペア数は maxPairs+1 (=65) 以下に抑えられているので、
    // 大きな bucketCount で finish しても 65 個以下しか返らない。
    // halve() が壊れていると生ペア 6400 個がそのまま返り、この assert が落ちる。
    const big = new PeakAccumulator({ windowSamples: 16, maxPairs: 64 })
    for (let i = 0; i < 100; i++) big.push(chunk)
    expect(big.finish(10_000).peaks.length).toBeLessThanOrEqual(65)
  })

  it('空入力では finish が peaks: [] と totalSamples: 0 を返す', () => {
    expect(new PeakAccumulator().finish()).toEqual({ peaks: [], totalSamples: 0 })
  })

  it('チャンク境界をまたぐ窓が欠落しない (push を細切れにしても同じ結果)', () => {
    const data = new Float32Array(1000).map(() => Math.random() * 2 - 1)
    const a = new PeakAccumulator({ windowSamples: 64 })
    a.push(data)
    const b = new PeakAccumulator({ windowSamples: 64 })
    for (let i = 0; i < data.length; i += 7) b.push(data.subarray(i, Math.min(i + 7, data.length)))
    expect(b.finish(100)).toEqual(a.finish(100))
  })
})
