import { z } from 'zod'
import { PRICING_SETTING_KEYS as PK } from './pricing.js'

// 転送見積もり用の接続プロファイル (spec: 2026-08-22-transfer-estimate-design.md)。
// 全て connection_settings の key/value なのでマイグレーションは要らない。
//
// **null は「既定に戻す」** (行を消す)。undefined は「触らない」。
// プロバイダは既定がエンドポイントからの推定なので、この区別が意味を持つ。
const ProviderEnum = z.enum(['aws', 'wasabi', 'onprem', 'other'])
const StorageClassEnum = z.enum([
  'STANDARD', 'INTELLIGENT_TIERING', 'STANDARD_IA', 'ONEZONE_IA',
  'GLACIER_IR', 'GLACIER', 'DEEP_ARCHIVE',
])

export const PricingPatch = z.object({
  provider:          ProviderEnum.nullable().optional(),
  region:            z.string().min(1).max(64).nullable().optional(),
  storageClass:      StorageClassEnum.nullable().optional(),
  readMbps:          z.number().positive().nullable().optional(),
  writeMbps:         z.number().positive().nullable().optional(),
  parallelism:       z.number().int().positive().nullable().optional(),
  requestOverheadMs: z.number().positive().nullable().optional(),
  // 0 (上振れ無し) は意味のある設定なので許す。
  instability:       z.number().min(0).nullable().optional(),
  capacityBytes:     z.number().positive().nullable().optional(),
  // 単価の手動上書き。0 は「無料」を意味するので許す。
  storagePerGbMonth: z.number().min(0).nullable().optional(),
  egressPerGb:       z.number().min(0).nullable().optional(),
  putPer1000:        z.number().min(0).nullable().optional(),
  getPer1000:        z.number().min(0).nullable().optional(),
})

export type PricingPatch = z.infer<typeof PricingPatch>

/** body のフィールド名 → connection_settings のキー。 */
const PRICING_FIELD_KEYS: Record<keyof PricingPatch, string> = {
  provider:          PK.provider,
  region:            PK.region,
  storageClass:      PK.storageClass,
  readMbps:          PK.readMbps,
  writeMbps:         PK.writeMbps,
  parallelism:       PK.parallelism,
  requestOverheadMs: PK.requestOverheadMs,
  instability:       PK.instability,
  capacityBytes:     PK.capacityBytes,
  storagePerGbMonth: PK.storagePerGbMonth,
  egressPerGb:       PK.egressPerGb,
  putPer1000:        PK.putPer1000,
  getPer1000:        PK.getPer1000,
}

/** PricingPatch → (書き込む key/value, 消す key)。 */
export function splitPricingPatch(
  patch: PricingPatch,
): { upserts: Array<readonly [string, string]>; deletes: string[] } {
  const upserts: Array<readonly [string, string]> = []
  const deletes: string[] = []
  for (const field of Object.keys(PRICING_FIELD_KEYS) as Array<keyof PricingPatch>) {
    const value = patch[field]
    if (value === undefined) continue
    if (value === null) deletes.push(PRICING_FIELD_KEYS[field])
    else upserts.push([PRICING_FIELD_KEYS[field], String(value)])
  }
  return { upserts, deletes }
}
