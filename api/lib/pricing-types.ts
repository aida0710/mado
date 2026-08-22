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

/** 単価の出所。**費用の数字がどれだけ確かかを画面で区別するために要る。**
 *
 *  - `api`      … AWS の料金 API から取得した値。「単価を更新」で新しくなる
 *  - `proxy`    … 料金 API に無いので、同額の別クラスの API 値で代用 (Deep Archive)
 *  - `manual`   … 料金 API が無く、Mado が公表値を焼いている (Wasabi)。
 *                 **更新しても変わらない** ので、UI で区別して注記する
 *  - `override` … その接続の設定で人が入れた値。本人が入れたので注記は要らない
 *  - `none`     … 費用の概念が無い接続 (社内ストレージ) */
export type RateSource = 'api' | 'proxy' | 'manual' | 'override' | 'none'

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
  /** ストレージ単価の出所。`proxy` は Deep Archive (料金 API に単価が無い)。 */
  storageRateSource: RateSource
  /** $/1000 リクエスト。 */
  putPer1000: number
  getPer1000: number
  /** $/GB。取り出し料金の無いクラスは 0。 */
  retrievalPerGb: number
  /** $/オブジェクト-月。Intelligent-Tiering の監視料。他は 0。 */
  monitoringPerObjectMonth: number
  /** 最小保存期間 (日)。これより早く消しても期間分は課金される。 */
  minDurationDays: number
  /** 最小課金サイズ (バイト)。これ未満のオブジェクトもこのサイズとして課金される。
   *  IA 系と Glacier Instant Retrieval の 128KB がこれ。料金 API には無い。 */
  minBillableBytes: number
  /** オブジェクトごとに**加算**されるバイト数。最小課金サイズとは別物で、
   *  大きいオブジェクトにも乗る。Glacier Flexible Retrieval / Deep Archive の
   *  メタデータ 40KB (8KB は Standard 料金、32KB は Glacier 料金) がこれ。
   *  単価を分けるほどの額ではないので、40KB 全部を同クラスの単価で数える。 */
  perObjectOverheadBytes: number
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
  /** Wasabi は料金 API を公開していないので常に 'manual'。 */
  rateSource: RateSource
}

/** 料金 API から取れない値の出所。**「単価を更新」しても変わらない部分**なので、
 *  取得日 (asOf) とは別に、人が確認した日を持って UI に出す。 */
export interface ManualFacts {
  /** 手で持っている値を最後に一次ソースで確認した日 (YYYY-MM-DD)。 */
  verifiedOn: string
  /** 何を手で持っているか。UI の脚注にそのまま出す。 */
  notes: string[]
  /** 確認に使った一次ソース。 */
  sources: string[]
}

export interface PricingCatalog {
  /** カタログを生成した日 (YYYY-MM-DD)。UI に "as of" として出す。 */
  asOf: string
  /** AWS 側の料金表の公表日。 */
  awsPublishedAt: string | null
  /** 料金 API から取れず、手で持っている値の出所。 */
  manualFacts: ManualFacts
  aws: { regions: Record<string, AwsRegionPricing> }
  wasabi: WasabiPricing
}
