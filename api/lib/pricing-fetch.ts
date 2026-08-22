// 料金カタログの取得 (spec: 2026-08-22-transfer-estimate-design.md)。
//
// ここだけが外部 (AWS) を叩く。呼び出し元は 2 つ:
//   - pricing.refresh ジョブ (実行時の更新)
//   - scripts/fetch-pricing.ts (同梱カタログの書き出し)
//
// 取得元は 2 つあり、**両方が要る**:
//
// - ストレージ / リクエスト / 取り出し → AWS 料金計算機が使う meteredUnitMap。
//   行名が表示名そのままなので、どのクラスのどの操作か判別できる。
// - egress → Price List API の **AWSDataTransfer** オファー。
//   AmazonS3 オファーにも Data Transfer 項目はあるが、そこは `$0.0/GB` が
//   入っており、鵜呑みにすると egress を 0 と計算してしまう。実際の単価は
//   AWSDataTransfer 側にしかない。
//
// AWS 側の名前が変わったときに「静かに 0 になる」のが最悪なので、必須の行が
// 引けなければ例外にする。ジョブは失敗として記録され、キャッシュは前の値のまま残る。

import type {
  AwsRegionPricing, EgressTier, PricingCatalog, StorageClassKey, StorageClassPricing, Tier,
} from './pricing-types.js'

const S3_METERED = 'https://calculator.aws/pricing/2.0/meteredUnitMaps/s3/USD/current/s3.json'
const PRICE_LIST = 'https://pricing.us-east-1.amazonaws.com'

/** 対象リージョン。meteredUnitMap は表示名キー、Price List はコードキー。 */
export const FETCH_REGIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  { code: 'us-east-1',      label: 'US East (N. Virginia)' },
]

/** ストレージクラス → meteredUnitMap の行名。
 *  minDurationDays / minBillableBytes は料金 API に無いのでドキュメント値。 */
interface ClassSpec {
  label: string
  /** [行名, その段の上限 GB (null = 最終段)]。 */
  storage: ReadonlyArray<readonly [string, number | null]>
  storageIsProxy?: boolean
  put: string
  get: string
  retrieval: string | null
  monitoring?: string
  minDurationDays: number
  minBillableBytes: number
}

const CLASSES: Record<StorageClassKey, ClassSpec> = {
  STANDARD: {
    label: 'Standard',
    storage: [
      ['Standard Storage First 50 TB per GB Mo',  51200],
      ['Standard Storage Next 450 TB per GB Mo', 512000],
      ['Standard Storage Over 500 TB per GB Mo',   null],
    ],
    put: 'PUT COPY/POST or LIST requests per Requests',
    get: 'GET and all other requests per Requests',
    retrieval: null,
    minDurationDays: 0,
    minBillableBytes: 0,
  },
  INTELLIGENT_TIERING: {
    label: 'Intelligent-Tiering',
    storage: [
      ['Intelligent Tiering Frequent Access First 50 TB per GB Mo',  51200],
      ['Intelligent Tiering Frequent Access Next 450 TB per GB Mo', 512000],
      ['Intelligent Tiering Frequent Access Over 500 TB per GB Mo',   null],
    ],
    put: 'PUT COPY/POST or LIST requests to Intelligent Tiering per Requests',
    get: 'GET and all other requests to Intelligent Tiering per Requests',
    retrieval: null,
    // 128KB 以上のオブジェクトに月あたりの監視料がかかる。
    monitoring: 'Per object per month monitoring and automation fee for objects in Intelligent Tiering',
    minDurationDays: 0,
    minBillableBytes: 0,
  },
  STANDARD_IA: {
    label: 'Standard-IA',
    storage: [['Standard Infrequent Access Storage per GB-Mo', null]],
    put: 'PUT COPY/POST or LIST requests to Standard Infrequent Access per Requests',
    get: 'GET and all other requests to Standard Infrequent Access per Requests',
    retrieval: 'Object Retrieval in Standard Infrequent Access per GB',
    minDurationDays: 30,
    minBillableBytes: 131072,
  },
  ONEZONE_IA: {
    label: 'One Zone-IA',
    storage: [['One Zone Infrequent Access Storage Inf per GB-Mo', null]],
    put: 'PUT COPY/POST or LIST requests to One Zone Infrequent Access per Requests',
    get: 'GET and all other requests to One Zone Infrequent Access per Requests',
    retrieval: 'Object Retrieval in One Zone Infrequent Access per GB',
    minDurationDays: 30,
    minBillableBytes: 131072,
  },
  GLACIER_IR: {
    label: 'Glacier Instant Retrieval',
    storage: [['Glacier Instant Retrieval Storage', null]],
    put: 'PUT COPY/POST or LIST requests to Glacier Instant Retrieval per Requests',
    get: 'GET and all other requests to Glacier Instant Retrieval per Requests',
    retrieval: 'Object Retrieval in Glacier Instant Retrieval per GB',
    minDurationDays: 90,
    minBillableBytes: 131072,
  },
  GLACIER: {
    label: 'Glacier Flexible Retrieval',
    storage: [['Glacier Storage per GB Mo', null]],
    put: 'PUT requests to Glacier per Requests',
    get: 'GET and all other requests to GLACIER per Requests',
    retrieval: 'Fee for Standard Retrieval of data stored',
    minDurationDays: 90,
    minBillableBytes: 40960,
  },
  DEEP_ARCHIVE: {
    label: 'Glacier Deep Archive',
    // Price List にも meteredUnitMap にも Deep Archive のストレージ単価は
    // 存在しない。Intelligent-Tiering の Deep Archive Access 層を代理に使う。
    // 単価が公表されている us-east-1 で両者が $0.00099 と一致することを確認済み。
    storage: [['IntelligentTieringDeepArchiveAccess', null]],
    storageIsProxy: true,
    // 直接 PUT もライフサイクル遷移も同単価。行があるのは遷移側だけ。
    put: 'Lifecycle Transition Requests into Glacier Deep Archive per Requests',
    get: 'GET and all other requests to GDA per Requests',
    retrieval: 'Fee for Standard Retrieval of data stored from Glacier Deep Archive',
    minDurationDays: 180,
    minBillableBytes: 40960,
  },
}

/** Wasabi は料金 API を持たない。公表値を定数で持つ。
 *  2026-07-01 に $6.99 → $7.99/TB/月 へ改定された。 */
const WASABI = {
  label: 'Wasabi Hot Cloud Storage',
  perTbMonthUsd: 7.99,
  minDurationDays: 90,
  minBillableTb: 1,
}

interface MeteredRow { price: string }
interface MeteredMap {
  manifest?: { hawkFilePublicationDate?: string }
  regions: Record<string, Record<string, MeteredRow>>
}

interface PriceDimension {
  beginRange?: string
  endRange?: string
  pricePerUnit?: { USD?: string }
}
interface PriceListDoc {
  products: Record<string, { attributes?: Record<string, string | undefined> }>
  terms: { OnDemand: Record<string, Record<string, {
    priceDimensions: Record<string, PriceDimension>
  }>> }
}

export interface FetchCatalogOptions {
  /** 差し替え可能な fetch。テストから注入する。 */
  fetchImpl?: typeof fetch
  /** 「今日」。asOf に使う。 */
  now?: () => Date
  /** 1 リクエストのタイムアウト。既定 30 秒。 */
  timeoutMs?: number
  /** ジョブのキャンセル。 */
  signal?: AbortSignal
  /** 進捗の通知 (ジョブの label に出す)。 */
  onProgress?: (message: string) => void
}

/** 二進浮動小数のゴミを落とす。$0.0047 × 1000 が 4.699999… になるのを避ける。 */
function round(n: number): number {
  return Number(n.toFixed(10))
}

/** meteredUnitMap から 1 行引く。無ければ落とす (静かに 0 にしない)。 */
function rate(rows: Record<string, MeteredRow>, name: string, region: string): number {
  const row = rows[name]
  if (!row) throw new Error(`料金の行が見つかりません (${region}): ${JSON.stringify(name)}`)
  const n = Number(row.price)
  if (!Number.isFinite(n)) throw new Error(`料金が数値ではありません (${region}): ${name}`)
  return n
}

/** Price List の OnDemand から、usagetype 一致の段階制価格を取り出す。 */
function tiersFromPriceList(doc: PriceListDoc, usagetype: string): EgressTier[] {
  const out: EgressTier[] = []
  for (const [sku, product] of Object.entries(doc.products)) {
    if (product.attributes?.usagetype !== usagetype) continue
    for (const term of Object.values(doc.terms.OnDemand[sku] ?? {})) {
      for (const dim of Object.values(term.priceDimensions)) {
        out.push({
          fromGb: Number(dim.beginRange),
          upToGb: dim.endRange === 'Inf' ? null : Number(dim.endRange),
          usd: round(Number(dim.pricePerUnit?.USD)),
        })
      }
    }
  }
  return out.sort((a, b) => a.fromGb - b.fromGb)
}

function buildStorageClasses(
  rows: Record<string, MeteredRow>,
  code: string,
): Record<StorageClassKey, StorageClassPricing> {
  const out = {} as Record<StorageClassKey, StorageClassPricing>
  for (const [key, spec] of Object.entries(CLASSES) as Array<[StorageClassKey, ClassSpec]>) {
    const storageTiers: Tier[] = spec.storage.map(([name, upToGb]) => ({
      upToGb,
      usd: rate(rows, name, code),
    }))
    out[key] = {
      label: spec.label,
      storageTiers,
      storageIsProxy: spec.storageIsProxy ?? false,
      // meteredUnitMap は 1 リクエストあたり。表示と突き合わせやすいよう
      // カタログでは $/1000 リクエストに直す。
      putPer1000: round(rate(rows, spec.put, code) * 1000),
      getPer1000: round(rate(rows, spec.get, code) * 1000),
      retrievalPerGb: spec.retrieval ? rate(rows, spec.retrieval, code) : 0,
      monitoringPerObjectMonth: spec.monitoring ? rate(rows, spec.monitoring, code) : 0,
      minDurationDays: spec.minDurationDays,
      minBillableBytes: spec.minBillableBytes,
    }
  }
  return out
}

function buildEgress(dt: PriceListDoc, code: string): { tiers: EgressTier[]; freeGb: number } {
  // `Global-DataTransfer-Out-Bytes` は全リージョン共通の**無料枠**であって
  // 単価表ではない。両方が `AWS Outbound / External` に該当するので、
  // `Global-` でない方を選ぶ。ここを取り違えると egress が丸ごと $0 になり、
  // しかも例外は出ない。
  //
  // プレフィックスはリージョンによって付いたり付かなかったりする
  // (`APN1-DataTransfer-Out-Bytes` / us-east-1 は素の `DataTransfer-Out-Bytes`)。
  const usagetype = Object.values(dt.products)
    .filter(p =>
      p.attributes?.transferType === 'AWS Outbound' &&
      p.attributes?.toLocation === 'External' &&
      typeof p.attributes?.usagetype === 'string' &&
      p.attributes.usagetype.endsWith('DataTransfer-Out-Bytes'))
    .map(p => p.attributes!.usagetype!)
    .find(u => !u.startsWith('Global-'))
  if (!usagetype) throw new Error(`egress の usagetype が見つかりません: ${code}`)

  const tiers = tiersFromPriceList(dt, usagetype)
  // 有料段階が 1 つも無いのは「取り違えた」ときの症状。空でなくても落とす。
  if (!tiers.some(t => t.usd > 0)) {
    throw new Error(`egress の単価が全て 0 です — usagetype を取り違えた可能性 (${code}: ${usagetype})`)
  }

  const freeGb = tiersFromPriceList(dt, 'Global-DataTransfer-Out-Bytes')
    .find(t => t.usd === 0)?.upToGb ?? 0

  return { tiers, freeGb }
}

export async function fetchCatalog(opts: FetchCatalogOptions = {}): Promise<PricingCatalog> {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? ((): Date => new Date())
  const timeoutMs = opts.timeoutMs ?? 30_000
  const progress = opts.onProgress ?? ((): void => {})

  async function getJson<T>(url: string): Promise<T> {
    // ジョブのキャンセルと自前のタイムアウトを合成する。外部が無応答のまま
    // ジョブが running で張り付くのを防ぐ。
    const ac = new AbortController()
    const onAbort = (): void => ac.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const res = await doFetch(url, { signal: ac.signal })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`)
      return await res.json() as T
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  progress('料金表を取得中')
  const s3 = await getJson<MeteredMap>(S3_METERED)

  const dtIndex = await getJson<{ regions: Record<string, { currentVersionUrl?: string }> }>(
    `${PRICE_LIST}/offers/v1.0/aws/AWSDataTransfer/current/region_index.json`,
  )

  const regions: Record<string, AwsRegionPricing> = {}
  for (const { code, label } of FETCH_REGIONS) {
    progress(`${code} の単価を取得中`)
    const rows = s3.regions[label]
    if (!rows) throw new Error(`料金表にリージョンがありません: ${label}`)

    const url = dtIndex.regions[code]?.currentVersionUrl
    if (!url) throw new Error(`AWSDataTransfer にリージョンがありません: ${code}`)
    const dt = await getJson<PriceListDoc>(`${PRICE_LIST}${url}`)
    const egress = buildEgress(dt, code)

    regions[code] = {
      label,
      storageClasses: buildStorageClasses(rows, code),
      egressTiers: egress.tiers,
      egressFreeGb: egress.freeGb,
    }
  }

  return {
    asOf: now().toISOString().slice(0, 10),
    awsPublishedAt: s3.manifest?.hawkFilePublicationDate ?? null,
    aws: { regions },
    wasabi: WASABI,
  }
}
