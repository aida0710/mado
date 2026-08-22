// テスト用のフィクスチャ。本番コードからは使わない。
//
// Connection に必須フィールドが増えるたび、各テストがインラインで持っている
// フィクスチャが軒並み型エラーになる (e6d6c6e では 8 ファイルを手で直した)。
// 入れ子のオブジェクトはここに 1 つだけ置き、各テストは import 1 行で済ませる。
//
// 注意: `npx tsc --noEmit` はテストファイルを見ない。この種の型変更は
// `npm run build` (tsc -b) で検証すること。

import type { ConnectionPricing } from './types'

/** 費用のかからない社内ストレージ相当。見積もりを検証しないテスト向けの既定。 */
export const PRICING_FIXTURE: ConnectionPricing = {
  provider: 'onprem',
  providerExplicit: false,
  region: null,
  storageClass: null,
  storageClassLabel: null,
  ratesResolved: true,
  readMbps: 300,
  writeMbps: 300,
  parallelism: 16,
  requestOverheadMs: 20,
  instability: 0.5,
  capacityBytes: null,
  storagePerGbMonth: null,
  egressPerGb: null,
  putPer1000: null,
  getPer1000: null,
  effective: {
    storagePerGbMonth: null,
    egressPerGb: null,
    putPer1000: 0,
    getPer1000: 0,
    retrievalPerGb: 0,
    minDurationDays: 0,
    minBillableBytes: 0,
    storageIsProxy: false,
  },
}
