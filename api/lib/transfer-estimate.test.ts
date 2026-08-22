import { describe, it, expect } from 'vitest'
import {
  estimateTransfer, tieredCost, putRequestCount, DEFAULT_PART_SIZE_BYTES,
} from './transfer-estimate.js'
import { GIB, type ConnectionProfile, type EffectiveRates } from './pricing.js'

const MIB = 1024 * 1024

function prof(over: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    connId: 'src', name: 'src', provider: 'onprem', region: null, storageClass: null,
    readMbps: 100, writeMbps: 100, parallelism: 16, requestOverheadMs: 20,
    // 既定は 0 にして「楽観 = 悲観」にしておく。上振れを見るテストだけ上げる。
    instability: 0,
    capacityBytes: null,
    overrides: { storagePerGbMonth: null, egressPerGb: null, putPer1000: null, getPer1000: null },
    ...over,
  }
}

function rates(over: Partial<EffectiveRates> = {}): EffectiveRates {
  return {
    storageTiers: [], egressTiers: [], egressFreeGb: 0,
    putPer1000: 0, getPer1000: 0, retrievalPerGb: 0, monitoringPerObjectMonth: 0,
    minDurationDays: 0, minBillableBytes: 0, perObjectOverheadBytes: 0,
    storageRateSource: 'api', storageClassLabel: null, ratesResolved: true,
    ...over,
  }
}

describe('tieredCost', () => {
  const tiers = [
    { upToGb: 50,   usd: 2 },
    { upToGb: 100,  usd: 1 },
    { upToGb: null, usd: 0.5 },
  ]

  it('0 は 0', () => {
    expect(tieredCost(0, tiers)).toBe(0)
    expect(tieredCost(-5, tiers)).toBe(0)
  })

  it('段の境界ちょうど', () => {
    expect(tieredCost(50, tiers)).toBeCloseTo(100)
    expect(tieredCost(100, tiers)).toBeCloseTo(150)
  })

  it('段をまたぐと超えた分だけ次の単価になる', () => {
    expect(tieredCost(60, tiers)).toBeCloseTo(110)   // 50*2 + 10*1
    expect(tieredCost(200, tiers)).toBeCloseTo(200)  // 150 + 100*0.5
  })

  it('段が空なら 0', () => {
    expect(tieredCost(1000, [])).toBe(0)
  })

  it('最終段に上限があっても、静かに 0 にせず最後の単価で延長する', () => {
    // カタログが壊れている場合の保険。落とすと過小評価になる。
    expect(tieredCost(200, [{ upToGb: 100, usd: 1 }])).toBeCloseTo(200)
  })

  it('AWS 東京の Standard を実カタログの値で引く', () => {
    const std = [
      { upToGb: 51200,  usd: 0.025 },
      { upToGb: 512000, usd: 0.024 },
      { upToGb: null,   usd: 0.023 },
    ]
    // 40 TiB = 40960 GiB。第 1 段に収まる。
    expect(tieredCost(40960, std)).toBeCloseTo(1024)
    // 100 TiB = 102400 GiB。51200 を超えた分が第 2 段。
    expect(tieredCost(102400, std)).toBeCloseTo(51200 * 0.025 + 51200 * 0.024)
  })
})

describe('putRequestCount', () => {
  it('分割サイズ以下なら 1 オブジェクト 1 リクエスト', () => {
    expect(putRequestCount(1000, 10 * MIB, DEFAULT_PART_SIZE_BYTES)).toBe(1000)
    expect(putRequestCount(1000, DEFAULT_PART_SIZE_BYTES, DEFAULT_PART_SIZE_BYTES)).toBe(1000)
  })

  it('分割サイズを超えると Create + N×Part + Complete', () => {
    // 300MiB / 64MiB = 5 パート → 5 + 2 = 7
    expect(putRequestCount(100, 300 * MIB, DEFAULT_PART_SIZE_BYTES)).toBe(700)
  })

  it('0 件なら 0', () => {
    expect(putRequestCount(0, 0, DEFAULT_PART_SIZE_BYTES)).toBe(0)
  })
})

describe('estimateTransfer / 所要時間', () => {
  it('大きいオブジェクトでは帯域が律速する', () => {
    const r = estimateTransfer({
      // 100 GB を 100 個 (平均 1GB)
      scan: { objectCount: 100, totalBytes: 100_000_000_000 },
      src: { profile: prof({ readMbps: 500 }), rates: rates() },
      dst: { profile: prof({ connId: 'dst', writeMbps: 1000 }), rates: rates() },
    })
    // min(500, 1000) MB/s = 5e8 B/s → 200 秒。
    // リクエスト側は 100 * 0.02 / 16 = 0.125 秒でしかない。
    expect(r.durationSec.optimistic).toBeCloseTo(200)
  })

  it('小さいオブジェクトが大量にあるとリクエストが律速する', () => {
    const r = estimateTransfer({
      // 1GB を 100 万個 (平均 1KB)
      scan: { objectCount: 1_000_000, totalBytes: 1_000_000_000 },
      src: { profile: prof({ readMbps: 500 }), rates: rates() },
      dst: { profile: prof({ connId: 'dst', writeMbps: 1000 }), rates: rates() },
    })
    // 帯域なら 2 秒で終わるが、実際は 1e6 * 0.02 / 16 = 1250 秒。
    expect(r.durationSec.optimistic).toBeCloseTo(1250)
  })

  it('遅い側が律速する', () => {
    const fast = estimateTransfer({
      scan: { objectCount: 1, totalBytes: 1_000_000_000 },
      src: { profile: prof({ readMbps: 1000 }), rates: rates() },
      dst: { profile: prof({ connId: 'dst', writeMbps: 100 }), rates: rates() },
    })
    expect(fast.durationSec.optimistic).toBeCloseTo(10)
  })

  it('不安定な接続ほど悲観側が伸びる', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1, totalBytes: 1_000_000_000 },
      src: { profile: prof({ readMbps: 100, instability: 0.5 }), rates: rates() },
      dst: { profile: prof({ connId: 'dst', writeMbps: 100, instability: 0.1 }), rates: rates() },
    })
    // 両端の大きい方を採る。
    expect(r.durationSec.optimistic).toBeCloseTo(10)
    expect(r.durationSec.pessimistic).toBeCloseTo(15)
  })

  it('同一接続内のクラス変更ではデータが回線を通らない', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1000, totalBytes: 1_000_000_000_000 },
      src: { profile: prof({ connId: 'same', readMbps: 10 }), rates: rates() },
      dst: { profile: prof({ connId: 'same', writeMbps: 10 }), rates: rates() },
    })
    expect(r.sameConnection).toBe(true)
    // 帯域なら 10 万秒。実際はリクエストぶんだけ (1000 * 0.02 / 16)。
    expect(r.durationSec.optimistic).toBeCloseTo(1.25)
  })
})

describe('estimateTransfer / 初期費用', () => {
  const awsEgress = rates({
    egressFreeGb: 100,
    egressTiers: [
      { upToGb: 10240,  usd: 0.114 },
      { upToGb: 51200,  usd: 0.089 },
      { upToGb: null,   usd: 0.086 },
    ],
  })

  it('移動元が社内ストレージなら egress は 0', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 100 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates() },
    })
    expect(r.upfront.egress).toBe(0)
  })

  it('AWS から出すと段階制の egress が乗る', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 1000 * GIB },
      src: { profile: prof({ provider: 'aws' }), rates: awsEgress },
      dst: { profile: prof({ connId: 'dst' }), rates: rates() },
    })
    // 無料枠 100GB を引いた 900GB が第 1 段。
    expect(r.upfront.egress).toBeCloseTo(900 * 0.114)
  })

  it('無料枠に収まるなら egress は 0', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1, totalBytes: 100 * GIB },
      src: { profile: prof({ provider: 'aws' }), rates: awsEgress },
      dst: { profile: prof({ connId: 'dst' }), rates: rates() },
    })
    expect(r.upfront.egress).toBe(0)
  })

  it('40TiB を東京から出すと約 $3,900', () => {
    const r = estimateTransfer({
      scan: { objectCount: 137_757, totalBytes: 40 * 1024 * GIB },
      src: { profile: prof({ provider: 'aws' }), rates: awsEgress },
      dst: { profile: prof({ connId: 'dst' }), rates: rates() },
    })
    // 40960 - 100 = 40860GB。10240 まで 0.114、残り 30620 が 0.089。
    expect(r.upfront.egress).toBeCloseTo(10240 * 0.114 + 30620 * 0.089, 0)
    expect(r.upfront.egress).toBeGreaterThan(3800)
    expect(r.upfront.egress).toBeLessThan(4000)
  })

  it('同一接続内のクラス変更では egress が発生しない', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 1000 * GIB },
      src: { profile: prof({ connId: 'same', provider: 'aws' }), rates: awsEgress },
      dst: { profile: prof({ connId: 'same', provider: 'aws' }), rates: rates() },
    })
    expect(r.upfront.egress).toBe(0)
  })

  it('移動元がアーカイブなら取り出し費用が乗る', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 1000 * GIB },
      src: { profile: prof({ provider: 'aws' }), rates: rates({ retrievalPerGb: 0.022 }) },
      dst: { profile: prof({ connId: 'dst' }), rates: rates() },
    })
    expect(r.upfront.retrieval).toBeCloseTo(1000 * 0.022)
  })

  it('PUT はマルチパートぶんを数える', () => {
    const r = estimateTransfer({
      // 平均 300MiB → 7 リクエスト/オブジェクト
      scan: { objectCount: 1000, totalBytes: 1000 * 300 * MIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ putPer1000: 0.065 }) },
    })
    expect(r.putRequestCount).toBe(7000)
    expect(r.upfront.putRequests).toBeCloseTo(7000 * 0.065 / 1000)
  })

  it('total は内訳の和', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1000, totalBytes: 1000 * GIB },
      src: {
        profile: prof({ provider: 'aws' }),
        rates: rates({ ...awsEgress, retrievalPerGb: 0.01, getPer1000: 0.001 }),
      },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ putPer1000: 0.0047 }) },
    })
    const { egress, retrieval, getRequests, putRequests, total } = r.upfront
    expect(total).toBeCloseTo(egress + retrieval + getRequests + putRequests)
    expect(total).toBeGreaterThan(0)
  })
})

describe('estimateTransfer / 月額', () => {
  it('段階制ストレージで計算する', () => {
    const r = estimateTransfer({
      scan: { objectCount: 100, totalBytes: 1000 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst' }),
        rates: rates({ storageTiers: [{ upToGb: null, usd: 0.025 }] }),
      },
    })
    expect(r.monthlyUsd).toBeCloseTo(25)
  })

  it('最小課金サイズを下回るオブジェクトは切り上げて課金される', () => {
    const r = estimateTransfer({
      // 1000 個 × 1KB = 1MB しかないが、Standard-IA は 128KB 単位。
      scan: { objectCount: 1000, totalBytes: 1000 * 1024 },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst' }),
        rates: rates({
          minBillableBytes: 128 * 1024,
          storageTiers: [{ upToGb: null, usd: 0.0138 }],
        }),
      },
    })
    expect(r.billableBytes).toBe(1000 * 128 * 1024)
    expect(r.monthlyUsd).toBeCloseTo((1000 * 128 * 1024 / GIB) * 0.0138)
  })

  it('最小課金サイズ以上なら実サイズで課金される', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1000, totalBytes: 1000 * MIB },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst' }),
        rates: rates({ minBillableBytes: 128 * 1024, storageTiers: [{ upToGb: null, usd: 1 }] }),
      },
    })
    expect(r.billableBytes).toBe(1000 * MIB)
  })

  it('Intelligent-Tiering の監視料はオブジェクト数に比例する', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1_000_000, totalBytes: 1_000_000 * MIB },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst' }),
        rates: rates({ monitoringPerObjectMonth: 0.0000025, storageTiers: [] }),
      },
    })
    expect(r.monthlyUsd).toBeCloseTo(2.5)
  })

  it('128KB 未満のオブジェクトは監視料の対象外', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1_000_000, totalBytes: 1_000_000 * 1024 },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst' }),
        rates: rates({ monitoringPerObjectMonth: 0.0000025 }),
      },
    })
    expect(r.monthlyUsd).toBe(0)
  })

  it('オブジェクトごとの加算は大きいオブジェクトにも乗る', () => {
    // Glacier 系の 40KB は「最小課金サイズ」ではなく「加算」。
    // 平均 1GB でも 1 件あたり 40KB 増える。
    const r = estimateTransfer({
      scan: { objectCount: 1000, totalBytes: 1000 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst' }),
        rates: rates({ perObjectOverheadBytes: 40960, storageTiers: [{ upToGb: null, usd: 1 }] }),
      },
    })
    expect(r.billableBytes).toBe(1000 * (GIB + 40960))
  })

  it('最小課金サイズと加算は両方効く', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1000, totalBytes: 1000 * 1024 },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst' }),
        rates: rates({ minBillableBytes: 128 * 1024, perObjectOverheadBytes: 40960 }),
      },
    })
    expect(r.billableBytes).toBe(1000 * (128 * 1024 + 40960))
  })

  it('社内ストレージは月額 0', () => {
    const r = estimateTransfer({
      scan: { objectCount: 100, totalBytes: 100 * 1024 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates() },
    })
    expect(r.monthlyUsd).toBe(0)
  })
})

describe('estimateTransfer / 警告', () => {
  function kinds(r: { warnings: Array<{ kind: string }> }): string[] {
    return r.warnings.map(w => w.kind)
  }

  it('最小保存期間', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ minDurationDays: 180 }) },
    })
    expect(kinds(r)).toContain('minDuration')
    expect(r.warnings.find(w => w.kind === 'minDuration')?.message).toContain('180')
  })

  it('アーカイブクラスは取り出し時間も警告する', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst', provider: 'aws', storageClass: 'DEEP_ARCHIVE' }),
        rates: rates({ retrievalPerGb: 0.022, minDurationDays: 180 }),
      },
    })
    expect(kinds(r)).toContain('archiveRetrievalTime')
    expect(kinds(r)).toContain('retrievalCost')
  })

  it('Glacier Instant Retrieval は取り出し時間を警告しない', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst', provider: 'aws', storageClass: 'GLACIER_IR' }),
        rates: rates({ retrievalPerGb: 0.03, minDurationDays: 90 }),
      },
    })
    expect(kinds(r)).not.toContain('archiveRetrievalTime')
    expect(kinds(r)).toContain('retrievalCost')
  })

  it('移動元がアーカイブなら復元待ちを警告する', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof({ provider: 'aws', storageClass: 'GLACIER' }), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates() },
    })
    expect(kinds(r)).toContain('sourceArchiveRestore')
  })

  it('Wasabi のポリシー', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst', provider: 'wasabi' }), rates: rates() },
    })
    expect(kinds(r)).toContain('wasabiPolicy')
  })

  it('容量超過', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 100 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst', capacityBytes: 50 * GIB }), rates: rates() },
    })
    expect(kinds(r)).toContain('capacity')
  })

  it('容量に収まるなら警告しない', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst', capacityBytes: 50 * GIB }), rates: rates() },
    })
    expect(kinds(r)).not.toContain('capacity')
  })

  it('小さいオブジェクトが多い', () => {
    const r = estimateTransfer({
      scan: { objectCount: 1000, totalBytes: 1000 * 1024 },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ minBillableBytes: 128 * 1024 }) },
    })
    expect(kinds(r)).toContain('smallObjects')
  })

  it('代理値の単価', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ storageRateSource: 'proxy' }) },
    })
    expect(kinds(r)).toContain('proxyRate')
  })

  it('手入力の単価は「更新しても変わらない」と伝える', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ storageRateSource: 'manual' }) },
    })
    const w = r.warnings.find(x => x.kind === 'manualRate')
    expect(w?.message).toContain('更新では新しくなりません')
  })

  it('人が入れた上書きには注記を出さない', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ storageRateSource: 'override' }) },
    })
    expect(kinds(r)).not.toContain('manualRate')
    expect(kinds(r)).not.toContain('proxyRate')
  })

  it('オブジェクトごとの加算が無視できない割合なら警告する', () => {
    const r = estimateTransfer({
      // 100 万件 × 平均 10KB。40KB の加算が本体の 4 倍になる。
      scan: { objectCount: 1_000_000, totalBytes: 1_000_000 * 10 * 1024 },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ perObjectOverheadBytes: 40960 }) },
    })
    const w = r.warnings.find(x => x.kind === 'objectOverhead')
    expect(w?.message).toContain('1,000,000 件')
  })

  it('加算が全体に比べて小さければ警告しない', () => {
    const r = estimateTransfer({
      // 1000 件 × 平均 1GB。40KB の加算は誤差。
      scan: { objectCount: 1000, totalBytes: 1000 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ perObjectOverheadBytes: 40960 }) },
    })
    expect(kinds(r)).not.toContain('objectOverhead')
  })

  it('単価が引けなかったときは「無料ではない」と伝える', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: {
        profile: prof({ connId: 'dst', provider: 'aws', region: 'eu-west-9' }),
        rates: rates({ ratesResolved: false }),
      },
    })
    const w = r.warnings.find(x => x.kind === 'ratesUnavailable')
    expect(w?.message).toContain('eu-west-9')
    expect(w?.message).toContain('無料という意味ではありません')
  })

  it('社内ストレージ同士なら警告は出ない', () => {
    const r = estimateTransfer({
      scan: { objectCount: 10, totalBytes: 10 * GIB },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates() },
    })
    expect(r.warnings).toEqual([])
  })
})

describe('estimateTransfer / 端', () => {
  it('空のディレクトリでも壊れない', () => {
    const r = estimateTransfer({
      scan: { objectCount: 0, totalBytes: 0 },
      src: { profile: prof(), rates: rates() },
      dst: { profile: prof({ connId: 'dst' }), rates: rates({ minBillableBytes: 128 * 1024 }) },
    })
    expect(r.avgObjectBytes).toBe(0)
    expect(r.putRequestCount).toBe(0)
    expect(r.billableBytes).toBe(0)
    expect(r.monthlyUsd).toBe(0)
    expect(r.durationSec.optimistic).toBe(0)
  })
})
