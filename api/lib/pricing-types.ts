// 料金カタログの型 (spec: 2026-08-22-transfer-estimate-design.md)。
//
// 型だけを持つ。カタログの実データは pricing/catalog.ts (生成物)、
// 参照ヘルパは pricing.ts。3 つに分けているのは、生成物が型を import し、
// ヘルパが両方を import する形にして循環を避けるため。

/** ストレージクラスのキー。S3 API の StorageClass 値に揃える。 */
export type StorageClassKey =
  | 'STANDARD'
  | 'INTELLIGENT_TIERING'
  | 'STANDARD_IA'
  | 'ONEZONE_IA'
  | 'GLACIER_IR'
  | 'GLACIER'
  | 'DEEP_ARCHIVE'

export const STORAGE_CLASS_KEYS: readonly StorageClassKey[] = [
  'STANDARD', 'INTELLIGENT_TIERING', 'STANDARD_IA', 'ONEZONE_IA',
  'GLACIER_IR', 'GLACIER', 'DEEP_ARCHIVE',
] as const

/** 累進課金の 1 段。`upToGb: null` が最終段。
 *  「この境界までは usd」という形で、超えた分だけ次の段の単価になる。 */
export interface Tier {
  upToGb: number | null
  usd: number
}

/** 段階制ストレージの 1 段。 */
export type StorageTier = Tier

export interface StorageClassPricing {
  label: string
  /** $/GB-月。累進 (段階を超えた分だけ次の単価)。 */
  storageTiers: StorageTier[]
  /** 単価が同クラスのものではなく代理値か (DEEP_ARCHIVE)。UI の脚注に出す。 */
  storageIsProxy: boolean
  /** $/1000 リクエスト。 */
  putPer1000: number
  getPer1000: number
  /** $/GB。取り出し料金の無いクラスは 0。 */
  retrievalPerGb: number
  /** $/オブジェクト-月。Intelligent-Tiering の監視料。他は 0。 */
  monitoringPerObjectMonth: number
  /** 最小保存期間 (日)。これより早く消しても期間分は課金される。 */
  minDurationDays: number
  /** 最小課金サイズ (バイト)。これ未満のオブジェクトもこのサイズとして課金。 */
  minBillableBytes: number
}

/** egress の 1 段。生成側が下端も持たせているので Tier に fromGb が付く
 *  (段が連続していることを目で確かめられるように)。計算では upToGb しか使わない。 */
export interface EgressTier extends Tier {
  fromGb: number
}

export interface AwsRegionPricing {
  label: string
  storageClasses: Record<StorageClassKey, StorageClassPricing>
  egressTiers: EgressTier[]
  /** 無料枠 (GB/月)。全リージョン共通で 100GB。 */
  egressFreeGb: number
}

export interface WasabiPricing {
  label: string
  perTbMonthUsd: number
  minDurationDays: number
  /** アカウント全体の最低課金 (TB/月)。警告文に出すだけで、月額には足さない
   *  — 既に他のデータがあれば最低額は満たされているため。 */
  minBillableTb: number
}

export interface PricingCatalog {
  /** カタログを生成した日 (YYYY-MM-DD)。UI に "as of" として出す。 */
  asOf: string
  /** AWS 側の料金表の公表日。 */
  awsPublishedAt: string | null
  aws: { regions: Record<string, AwsRegionPricing> }
  wasabi: WasabiPricing
}
