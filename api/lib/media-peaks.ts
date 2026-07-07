// ストリーミングで音声サンプル列の min/max ピークを一定メモリで集計する。
// 「窓 (windowSamples) ごとの [min,max] ペア列」を保持し、ペア数が maxPairs を
// 超えたら隣接ペアをマージして窓を倍にする — 総サンプル数を事前に知らなくても
// メモリは maxPairs で頭打ちになる。finish() で任意のバケット数に縮約する。

export const PEAK_BUCKETS = 2000

export interface PeakAccumulatorOpts {
  windowSamples?: number
  maxPairs?: number
}

export class PeakAccumulator {
  private windowSamples: number
  private readonly maxPairs: number
  private pairs: Array<[number, number]> = []
  private curMin = Infinity
  private curMax = -Infinity
  private curCount = 0
  private total = 0

  constructor(opts: PeakAccumulatorOpts = {}) {
    this.windowSamples = opts.windowSamples ?? 1024
    this.maxPairs = opts.maxPairs ?? 100_000
  }

  push(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]
      if (v < this.curMin) this.curMin = v
      if (v > this.curMax) this.curMax = v
      this.curCount++
      this.total++
      if (this.curCount === this.windowSamples) this.flushWindow()
    }
  }

  private flushWindow(): void {
    this.pairs.push([this.curMin, this.curMax])
    this.curMin = Infinity
    this.curMax = -Infinity
    this.curCount = 0
    if (this.pairs.length > this.maxPairs) this.halve()
  }

  // 隣接ペアをマージして解像度を半分にする (窓は倍になる)。
  private halve(): void {
    const merged: Array<[number, number]> = []
    for (let i = 0; i < this.pairs.length; i += 2) {
      const a = this.pairs[i]
      const b = this.pairs[i + 1]
      merged.push(b ? [Math.min(a[0], b[0]), Math.max(a[1], b[1])] : a)
    }
    this.pairs = merged
    this.windowSamples *= 2
  }

  finish(bucketCount = PEAK_BUCKETS): { peaks: Array<[number, number]>; totalSamples: number } {
    if (this.curCount > 0) {
      this.pairs.push([this.curMin, this.curMax])
      this.curMin = Infinity
      this.curMax = -Infinity
      this.curCount = 0
    }
    const src = this.pairs
    if (src.length === 0) return { peaks: [], totalSamples: this.total }
    if (src.length <= bucketCount) {
      return { peaks: src.map(p => [...p] as [number, number]), totalSamples: this.total }
    }
    // src.length 個のペアを bucketCount 個へ等分マージ
    const peaks: Array<[number, number]> = []
    for (let b = 0; b < bucketCount; b++) {
      const start = Math.floor((b * src.length) / bucketCount)
      const end = Math.max(start + 1, Math.floor(((b + 1) * src.length) / bucketCount))
      let mn = Infinity
      let mx = -Infinity
      for (let i = start; i < end; i++) {
        if (src[i][0] < mn) mn = src[i][0]
        if (src[i][1] > mx) mx = src[i][1]
      }
      peaks.push([mn, mx])
    }
    return { peaks, totalSamples: this.total }
  }
}
