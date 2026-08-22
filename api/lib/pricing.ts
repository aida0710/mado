// 料金カタログの参照と、接続ごとの見積もりプロファイル
// (spec: 2026-08-22-transfer-estimate-design.md)。
//
// ここは「接続の設定 + カタログ → 実効単価」までを引き受ける。
// 実際の計算は transfer-estimate.ts (S3 も DB もカタログも知らない純関数)。

import { CATALOG } from '../pricing/catalog.js'
import type {
  PricingCatalog, StorageClassKey, StorageClassPricing, Tier,
} from './pricing-types.js'
import { STORAGE_CLASS_KEYS } from './pricing-types.js'

export { CATALOG }

/** 課金は 1GB = 2^30 バイト。AWS も Wasabi も表記は "GB" だが実体は GiB。 */
export const GIB = 1024 ** 3

export type Provider = 'aws' | 'wasabi' | 'onprem' | 'other'

export const PROVIDERS: readonly Provider[] = ['aws', 'wasabi', 'onprem', 'other'] as const

/** エンドポイントのホスト名からプロバイダを推定する。
 *  推定結果は設定画面に出し、外れていれば手で直せるようにする。 */
export function inferProvider(endpoint: string): Provider {
  let host: string
  try {
    host = new URL(endpoint).hostname.toLowerCase()
  } catch {
    return 'onprem'
  }
  if (host === 'amazonaws.com' || host.endsWith('.amazonaws.com')) return 'aws'
  if (host === 'wasabisys.com' || host.endsWith('.wasabisys.com')) return 'wasabi'
  // 社内・その他の S3 互換実装。コスト 0 として扱う (下記 emptyRates)。
  return 'onprem'
}

/** プロバイダごとの性能の既定値。**これは当て推量である。**
 *  実運用では接続ごとに実測値を入れて上書きする前提で、
 *  何も設定していない接続でも見積もりが出るようにするための下駄。 */
interface PerfDefaults {
  readMbps: number
  writeMbps: number
  parallelism: number
  requestOverheadMs: number
  instability: number
}

const PERF_DEFAULTS: Record<Provider, PerfDefaults> = {
  // クラウド側は広帯域だが、こちらの回線が細ければそこが律速になる。
  aws:    { readMbps: 1000, writeMbps: 1000, parallelism: 16, requestOverheadMs: 25, instability: 0.2 },
  wasabi: { readMbps:  500, writeMbps:  500, parallelism: 16, requestOverheadMs: 30, instability: 0.3 },
  // 社内ストレージは実装によって幅が大きい。悲観側を厚めに取る。
  onprem: { readMbps:  300, writeMbps:  300, parallelism: 16, requestOverheadMs: 20, instability: 0.5 },
  other:  { readMbps:  300, writeMbps:  300, parallelism: 16, requestOverheadMs: 20, instability: 0.5 },
}

/** connection_settings のキー。`cap.` (権限) と混ざらないよう接頭辞で分ける。 */
export const PRICING_SETTING_KEYS = {
  provider:          'provider',
  region:            'pricing.region',
  storageClass:      'pricing.storage_class',
  readMbps:          'perf.read_mbps',
  writeMbps:         'perf.write_mbps',
  parallelism:       'perf.parallelism',
  requestOverheadMs: 'perf.request_overhead_ms',
  instability:       'perf.instability',
  storagePerGbMonth: 'cost.storage_per_gb_month',
  egressPerGb:       'cost.egress_per_gb',
  putPer1000:        'cost.put_per_1000',
  getPer1000:        'cost.get_per_1000',
  capacityBytes:     'capacity.total_bytes',
} as const

/** 見積もりに使う接続の姿。DB の行と connection_settings から組み立てる。 */
export interface ConnectionProfile {
  connId: string
  name: string
  provider: Provider
  /** aws のときカタログのリージョンキー。カタログに無ければ null。 */
  region: string | null
  /** aws のときの書き込み先クラス。他プロバイダでは null。 */
  storageClass: StorageClassKey | null
  readMbps: number
  writeMbps: number
  parallelism: number
  requestOverheadMs: number
  instability: number
  capacityBytes: number | null
  /** カタログより優先する手動上書き。未設定は null。 */
  overrides: {
    storagePerGbMonth: number | null
    egressPerGb: number | null
    putPer1000: number | null
    getPer1000: number | null
  }
}

/** 見積もり計算が実際に使う単価一式。プロバイダ差はここで吸収され、
 *  transfer-estimate.ts からはプロバイダが見えない。 */
export interface EffectiveRates {
  /** $/GB-月 (累進)。 */
  storageTiers: Tier[]
  /** $/GB (累進)。egress の無い接続は空配列。 */
  egressTiers: Tier[]
  egressFreeGb: number
  putPer1000: number
  getPer1000: number
  retrievalPerGb: number
  monitoringPerObjectMonth: number
  minDurationDays: number
  minBillableBytes: number
  /** ストレージ単価が同クラスの実値でなく代理値か (Deep Archive)。 */
  storageIsProxy: boolean
  /** 表示用のクラス名。クラスの概念が無いプロバイダでは null。 */
  storageClassLabel: string | null
  /** 単価を引けたか。`false` は「カタログに無い」— コストが 0 と表示されるが
   *  それは無料という意味ではない。社内ストレージの 0 と区別するために要る。 */
  ratesResolved: boolean
}

function positive(settings: Record<string, string>, key: string): number | null {
  const n = Number(settings[key])
  return Number.isFinite(n) && n > 0 ? n : null
}

function nonNegative(settings: Record<string, string>, key: string): number | null {
  const raw = settings[key]
  if (raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parseProvider(v: string | undefined): Provider | null {
  return v !== undefined && (PROVIDERS as readonly string[]).includes(v) ? (v as Provider) : null
}

function parseStorageClass(v: string | undefined): StorageClassKey | null {
  return v !== undefined && (STORAGE_CLASS_KEYS as readonly string[]).includes(v)
    ? (v as StorageClassKey)
    : null
}

/** 接続行 + connection_settings → 見積もりプロファイル。
 *
 *  権限と同じく **行が無い = 既定** の約束を守る。設定を一度も触っていない
 *  接続でも、エンドポイントからの推定と既定値で見積もりが出る。 */
export function settingsToProfile(
  conn: { id: string; name: string; endpoint: string; region: string },
  settings: Record<string, string>,
): ConnectionProfile {
  const provider = parseProvider(settings[PRICING_SETTING_KEYS.provider])
    ?? inferProvider(conn.endpoint)
  const perf = PERF_DEFAULTS[provider]

  // リージョンは明示設定 → 接続の region の順。カタログに載っているかは
  // ここでは判定しない (載っていないことは effectiveRates が
  // ratesResolved: false として伝える)。勝手に別リージョンで代用はしない。
  const region = provider === 'aws'
    ? (settings[PRICING_SETTING_KEYS.region] || conn.region)
    : null

  return {
    connId: conn.id,
    name: conn.name,
    provider,
    region,
    storageClass: provider === 'aws'
      ? (parseStorageClass(settings[PRICING_SETTING_KEYS.storageClass]) ?? 'STANDARD')
      : null,
    readMbps:          positive(settings, PRICING_SETTING_KEYS.readMbps)          ?? perf.readMbps,
    writeMbps:         positive(settings, PRICING_SETTING_KEYS.writeMbps)         ?? perf.writeMbps,
    parallelism:       positive(settings, PRICING_SETTING_KEYS.parallelism)       ?? perf.parallelism,
    requestOverheadMs: positive(settings, PRICING_SETTING_KEYS.requestOverheadMs) ?? perf.requestOverheadMs,
    // 不安定さは 0 (= 上振れ無し) を明示的に設定できてよい。
    instability:       nonNegative(settings, PRICING_SETTING_KEYS.instability)    ?? perf.instability,
    capacityBytes:     positive(settings, PRICING_SETTING_KEYS.capacityBytes),
    overrides: {
      storagePerGbMonth: nonNegative(settings, PRICING_SETTING_KEYS.storagePerGbMonth),
      egressPerGb:       nonNegative(settings, PRICING_SETTING_KEYS.egressPerGb),
      putPer1000:        nonNegative(settings, PRICING_SETTING_KEYS.putPer1000),
      getPer1000:        nonNegative(settings, PRICING_SETTING_KEYS.getPer1000),
    },
  }
}

/** コストの掛からない接続 (社内ストレージ) の単価。 */
function emptyRates(): EffectiveRates {
  return {
    storageTiers: [],
    egressTiers: [],
    egressFreeGb: 0,
    putPer1000: 0,
    getPer1000: 0,
    retrievalPerGb: 0,
    monitoringPerObjectMonth: 0,
    minDurationDays: 0,
    minBillableBytes: 0,
    storageIsProxy: false,
    storageClassLabel: null,
    ratesResolved: true,
  }
}

function awsRates(cls: StorageClassPricing, region: {
  egressTiers: readonly { upToGb: number | null; usd: number }[]
  egressFreeGb: number
}): EffectiveRates {
  return {
    storageTiers: cls.storageTiers.map(t => ({ upToGb: t.upToGb, usd: t.usd })),
    egressTiers: region.egressTiers.map(t => ({ upToGb: t.upToGb, usd: t.usd })),
    egressFreeGb: region.egressFreeGb,
    putPer1000: cls.putPer1000,
    getPer1000: cls.getPer1000,
    retrievalPerGb: cls.retrievalPerGb,
    monitoringPerObjectMonth: cls.monitoringPerObjectMonth,
    minDurationDays: cls.minDurationDays,
    minBillableBytes: cls.minBillableBytes,
    storageIsProxy: cls.storageIsProxy,
    storageClassLabel: cls.label,
    ratesResolved: true,
  }
}

/** プロファイル + カタログ → 実効単価。手動上書きは最後に被せる。 */
export function effectiveRates(
  profile: ConnectionProfile,
  catalog: PricingCatalog = CATALOG,
): EffectiveRates {
  let rates: EffectiveRates

  if (profile.provider === 'aws' && profile.region && profile.storageClass) {
    const region = catalog.aws.regions[profile.region]
    rates = region
      ? awsRates(region.storageClasses[profile.storageClass], region)
      // カタログに無いリージョン。0 にはなるが「無料」ではないので印を付ける。
      : { ...emptyRates(), ratesResolved: false }
  } else if (profile.provider === 'wasabi') {
    const w = catalog.wasabi
    rates = {
      ...emptyRates(),
      // 定額 $/TB-月 を $/GB-月 に直す。段階は無い。
      storageTiers: [{ upToGb: null, usd: w.perTbMonthUsd / 1024 }],
      minDurationDays: w.minDurationDays,
      storageClassLabel: w.label,
    }
  } else {
    // onprem / other。コスト 0 は「掛からない」という意味であり、正しい。
    rates = emptyRates()
  }

  const o = profile.overrides
  return {
    ...rates,
    storageTiers: o.storagePerGbMonth !== null
      ? [{ upToGb: null, usd: o.storagePerGbMonth }]
      : rates.storageTiers,
    egressTiers: o.egressPerGb !== null
      ? [{ upToGb: null, usd: o.egressPerGb }]
      : rates.egressTiers,
    putPer1000: o.putPer1000 ?? rates.putPer1000,
    getPer1000: o.getPer1000 ?? rates.getPer1000,
    // 上書きした単価は代理値かどうかの話ではなくなる。
    storageIsProxy: o.storagePerGbMonth !== null ? false : rates.storageIsProxy,
  }
}
