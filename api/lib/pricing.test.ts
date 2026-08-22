import { describe, it, expect } from 'vitest'
import {
  CATALOG, GIB, PRICING_SETTING_KEYS as K,
  effectiveRates, inferProvider, settingsToProfile,
} from './pricing.js'
import { STORAGE_CLASS_KEYS } from './pricing-types.js'

const CONN = { id: 'c1', name: 'test', endpoint: 'https://s3.example.com', region: 'auto' }

describe('inferProvider', () => {
  it('AWS', () => {
    expect(inferProvider('https://s3.ap-northeast-1.amazonaws.com')).toBe('aws')
    expect(inferProvider('https://bucket.s3.amazonaws.com')).toBe('aws')
  })

  it('Wasabi', () => {
    expect(inferProvider('https://s3.ap-northeast-1.wasabisys.com')).toBe('wasabi')
  })

  it('それ以外は社内ストレージ扱い', () => {
    expect(inferProvider('https://minio.lan:9000')).toBe('onprem')
    expect(inferProvider('http://10.0.0.5:9000')).toBe('onprem')
  })

  it('似せただけのホスト名には引っかからない', () => {
    // ドメイン末尾の一致で判定するので、部分一致では aws にならない。
    expect(inferProvider('https://amazonaws.com.evil.example')).toBe('onprem')
    expect(inferProvider('https://not-wasabisys.com')).toBe('onprem')
  })

  it('壊れた URL は社内ストレージ扱い (見積もりを落とさない)', () => {
    expect(inferProvider('not a url')).toBe('onprem')
  })
})

describe('settingsToProfile', () => {
  it('設定が空なら推定と既定値で埋まる', () => {
    const p = settingsToProfile(CONN, {})
    expect(p.provider).toBe('onprem')
    expect(p.storageClass).toBeNull()
    expect(p.readMbps).toBeGreaterThan(0)
    expect(p.parallelism).toBeGreaterThan(0)
    expect(p.capacityBytes).toBeNull()
    expect(p.overrides.storagePerGbMonth).toBeNull()
  })

  it('provider を明示すると推定より優先される', () => {
    const p = settingsToProfile(CONN, { [K.provider]: 'wasabi' })
    expect(p.provider).toBe('wasabi')
  })

  it('未知の provider は無視して推定に戻る', () => {
    const p = settingsToProfile(CONN, { [K.provider]: 'gcs' })
    expect(p.provider).toBe('onprem')
  })

  it('aws ならストレージクラスの既定は STANDARD', () => {
    const p = settingsToProfile(CONN, { [K.provider]: 'aws' })
    expect(p.storageClass).toBe('STANDARD')
  })

  it('未知のストレージクラスは既定に倒す', () => {
    const p = settingsToProfile(CONN, { [K.provider]: 'aws', [K.storageClass]: 'BOGUS' })
    expect(p.storageClass).toBe('STANDARD')
  })

  it('リージョンは明示設定が接続の region より優先される', () => {
    const conn = { ...CONN, region: 'us-east-1' }
    expect(settingsToProfile(conn, { [K.provider]: 'aws' }).region).toBe('us-east-1')
    expect(settingsToProfile(conn, {
      [K.provider]: 'aws', [K.region]: 'ap-northeast-1',
    }).region).toBe('ap-northeast-1')
  })

  it('aws 以外ではリージョンを持たない', () => {
    expect(settingsToProfile(CONN, { [K.region]: 'ap-northeast-1' }).region).toBeNull()
  })

  it('性能値を上書きできる', () => {
    const p = settingsToProfile(CONN, {
      [K.readMbps]: '840', [K.writeMbps]: '700',
      [K.parallelism]: '32', [K.requestOverheadMs]: '5', [K.instability]: '1.2',
    })
    expect(p.readMbps).toBe(840)
    expect(p.writeMbps).toBe(700)
    expect(p.parallelism).toBe(32)
    expect(p.requestOverheadMs).toBe(5)
    expect(p.instability).toBe(1.2)
  })

  it('不安定さは 0 を明示できる', () => {
    // 「上振れ無し」は意味のある設定なので、0 を「未設定」と混同しない。
    expect(settingsToProfile(CONN, { [K.instability]: '0' }).instability).toBe(0)
  })

  it('壊れた値や 0 以下の性能値は既定に倒す', () => {
    const base = settingsToProfile(CONN, {})
    const p = settingsToProfile(CONN, {
      [K.readMbps]: 'fast', [K.writeMbps]: '0', [K.parallelism]: '-4',
    })
    expect(p.readMbps).toBe(base.readMbps)
    expect(p.writeMbps).toBe(base.writeMbps)
    expect(p.parallelism).toBe(base.parallelism)
  })

  it('容量と単価の上書きを読む', () => {
    const p = settingsToProfile(CONN, {
      [K.capacityBytes]: String(320 * 1024 * GIB),
      [K.storagePerGbMonth]: '0.004',
      [K.egressPerGb]: '0',
      [K.putPer1000]: '0.01',
      [K.getPer1000]: '0.001',
    })
    expect(p.capacityBytes).toBe(320 * 1024 * GIB)
    expect(p.overrides.storagePerGbMonth).toBe(0.004)
    // 「明示的に 0」と「未設定」は別物。
    expect(p.overrides.egressPerGb).toBe(0)
    expect(p.overrides.putPer1000).toBe(0.01)
    expect(p.overrides.getPer1000).toBe(0.001)
  })
})

describe('effectiveRates', () => {
  const aws = (over: Record<string, string> = {}) =>
    settingsToProfile({ ...CONN, region: 'ap-northeast-1' }, { [K.provider]: 'aws', ...over })

  it('AWS Standard の単価を引く', () => {
    const r = effectiveRates(aws())
    expect(r.ratesResolved).toBe(true)
    expect(r.storageTiers.length).toBeGreaterThan(0)
    expect(r.storageTiers[0].usd).toBeGreaterThan(0)
    expect(r.putPer1000).toBeGreaterThan(0)
    expect(r.egressTiers.length).toBeGreaterThan(0)
    expect(r.minDurationDays).toBe(0)
    expect(r.storageIsProxy).toBe(false)
  })

  it('Standard-IA には最小保存期間と最小課金サイズがある', () => {
    const r = effectiveRates(aws({ [K.storageClass]: 'STANDARD_IA' }))
    expect(r.minDurationDays).toBe(30)
    expect(r.minBillableBytes).toBe(128 * 1024)
    expect(r.retrievalPerGb).toBeGreaterThan(0)
  })

  it('Deep Archive の単価は代理値である印が立つ', () => {
    const r = effectiveRates(aws({ [K.storageClass]: 'DEEP_ARCHIVE' }))
    expect(r.storageIsProxy).toBe(true)
    expect(r.minDurationDays).toBe(180)
  })

  it('アーカイブ系ほどストレージは安く PUT は高い', () => {
    const std = effectiveRates(aws())
    const gda = effectiveRates(aws({ [K.storageClass]: 'DEEP_ARCHIVE' }))
    expect(gda.storageTiers[0].usd).toBeLessThan(std.storageTiers[0].usd)
    expect(gda.putPer1000).toBeGreaterThan(std.putPer1000)
  })

  it('カタログに無いリージョンは「引けなかった」印が立つ', () => {
    const p = settingsToProfile({ ...CONN, region: 'moon-base-1' }, { [K.provider]: 'aws' })
    const r = effectiveRates(p)
    expect(r.ratesResolved).toBe(false)
    // 0 になるが、それは「無料」ではない。呼び出し側が警告を出すための印。
    expect(r.storageTiers).toEqual([])
  })

  it('Wasabi は定額で egress が無い', () => {
    const r = effectiveRates(settingsToProfile(CONN, { [K.provider]: 'wasabi' }))
    expect(r.storageTiers).toHaveLength(1)
    expect(r.storageTiers[0].usd).toBeCloseTo(CATALOG.wasabi.perTbMonthUsd / 1024)
    expect(r.egressTiers).toEqual([])
    expect(r.putPer1000).toBe(0)
    expect(r.minDurationDays).toBe(90)
  })

  it('社内ストレージは全て 0 だが「引けた」扱い', () => {
    const r = effectiveRates(settingsToProfile(CONN, {}))
    expect(r.ratesResolved).toBe(true)
    expect(r.storageTiers).toEqual([])
    expect(r.putPer1000).toBe(0)
  })

  it('手動上書きはカタログより優先される', () => {
    const r = effectiveRates(aws({
      [K.storagePerGbMonth]: '0.004',
      [K.egressPerGb]: '0.05',
      [K.putPer1000]: '0.001',
      [K.getPer1000]: '0.0001',
    }))
    expect(r.storageTiers).toEqual([{ upToGb: null, usd: 0.004 }])
    expect(r.egressTiers).toEqual([{ upToGb: null, usd: 0.05 }])
    expect(r.putPer1000).toBe(0.001)
    expect(r.getPer1000).toBe(0.0001)
  })

  it('ストレージ単価を上書きすると代理値の印は下りる', () => {
    const r = effectiveRates(aws({
      [K.storageClass]: 'DEEP_ARCHIVE', [K.storagePerGbMonth]: '0.002',
    }))
    expect(r.storageIsProxy).toBe(false)
  })

  it('社内ストレージにも単価を入れられる', () => {
    // 社内でも「1TB あたり月いくら」の内部原価を持っている場合。
    const r = effectiveRates(settingsToProfile(CONN, { [K.storagePerGbMonth]: '0.001' }))
    expect(r.storageTiers).toEqual([{ upToGb: null, usd: 0.001 }])
  })
})

describe('料金カタログ', () => {
  it('取得日を持つ', () => {
    expect(CATALOG.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('全ストレージクラスが全リージョンに揃っている', () => {
    for (const [code, region] of Object.entries(CATALOG.aws.regions)) {
      for (const key of STORAGE_CLASS_KEYS) {
        const cls = region.storageClasses[key]
        expect(cls, `${code}/${key}`).toBeDefined()
        expect(cls.storageTiers.length, `${code}/${key}`).toBeGreaterThan(0)
        for (const t of cls.storageTiers) {
          expect(t.usd, `${code}/${key}`).toBeGreaterThan(0)
        }
        // 最終段は上限なし。ここが有限だと大容量で計算が止まる。
        expect(cls.storageTiers[cls.storageTiers.length - 1].upToGb, `${code}/${key}`).toBeNull()
        expect(cls.putPer1000, `${code}/${key}`).toBeGreaterThan(0)
        expect(cls.getPer1000, `${code}/${key}`).toBeGreaterThan(0)
        expect(cls.retrievalPerGb, `${code}/${key}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('egress に有料段階がある', () => {
    // AmazonS3 オファーの Data Transfer 項目は $0 なので、そちらを読んでいると
    // ここで落ちる。生成スクリプト側でも弾いているが、カタログ側でも見張る。
    for (const [code, region] of Object.entries(CATALOG.aws.regions)) {
      expect(region.egressTiers.length, code).toBeGreaterThan(0)
      expect(region.egressTiers.some(t => t.usd > 0), code).toBe(true)
      expect(region.egressFreeGb, code).toBeGreaterThan(0)
    }
  })

  it('egress の段が連続していて最終段が開いている', () => {
    for (const [code, region] of Object.entries(CATALOG.aws.regions)) {
      let prev = 0
      for (const t of region.egressTiers) {
        expect(t.fromGb, code).toBe(prev)
        prev = t.upToGb ?? Infinity
      }
      expect(prev, code).toBe(Infinity)
    }
  })

  it('Deep Archive だけが代理値である', () => {
    for (const region of Object.values(CATALOG.aws.regions)) {
      for (const key of STORAGE_CLASS_KEYS) {
        expect(region.storageClasses[key].storageIsProxy).toBe(key === 'DEEP_ARCHIVE')
      }
    }
  })

  it('Wasabi の定額を持つ', () => {
    expect(CATALOG.wasabi.perTbMonthUsd).toBeGreaterThan(0)
    expect(CATALOG.wasabi.minDurationDays).toBe(90)
  })
})
