import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'
import type { JobStore } from '../lib/jobs.js'
import { CONNECTION_SETTINGS_SUBQUERY } from '../storage.js'
import { effectiveRates, settingsToProfile } from '../lib/pricing.js'
import type { PricingStore } from '../lib/pricing-store.js'
import { estimateTransfer, type Endpoint } from '../lib/transfer-estimate.js'
import { SCAN_KIND, scanDedupKey } from './storage-scan.js'
import {
  PRICING_REFRESH_DEDUP_KEY, PRICING_REFRESH_KIND,
  isStale, readRefreshDays, shouldAutoRefresh,
} from './pricing.js'

// 転送先ごとの費用・所要時間の見積もり
// (spec: 2026-08-22-transfer-estimate-design.md)。
//
// S3 を一切叩かない。DB に残っている走査結果と接続設定だけから計算する。
// そのため capabilityGuard も通さない (internal.ts の cap() 登録に無い) —
// list 権限すら不要で、権限を全部落とした接続でも見積もりの候補にはなる。

// 走査結果のうち見積もりが使うのは 2 つだけ。内訳 (children / extensions) は
// 読まないので、形の検証も最小限にする。
const ScanShape = z.object({
  objectCount: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
})

interface ConnRow {
  id: string
  name: string
  endpoint: string
  region: string
  settings: Record<string, string>
}

const SELECT_CONNS = `
  SELECT c.id, c.name, c.endpoint, c.region,
         ${CONNECTION_SETTINGS_SUBQUERY}
    FROM storage_connections c
   ORDER BY c.name`

export interface StorageEstimateDeps {
  pools: Pools
  store: JobStore
  pricing: PricingStore
  /** 「今日」。カタログの鮮度判定に使う。テストから差し替えられるようにする。 */
  now?: () => Date
}

export function mountStorageEstimateRoutes(app: Hono, deps: StorageEstimateDeps): void {
  const now = deps.now ?? (() => new Date())

  app.get('/storage/:connId/estimate', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const prefix = c.req.query('prefix') ?? ''

    // 走査は投げ直さない。重い操作を暗黙に起動しないという走査仕様の方針を
    // 踏襲し、無ければ 409 を返して UI に「先に走査して」と言わせる。
    const job = await deps.store.latestDone(SCAN_KIND, scanDedupKey(connId, bucket, prefix))
    if (!job) {
      return c.json({ error: 'このディレクトリはまだ走査されていません' }, 409)
    }
    const scan = ScanShape.safeParse(job.result)
    if (!scan.success) {
      return c.json({ error: '走査結果を読めませんでした。再走査してください' }, 409)
    }

    const rows = (await deps.pools.ro.query<ConnRow>(SELECT_CONNS)).rows
    const srcRow = rows.find(r => r.id === connId)
    if (!srcRow) return c.json({ error: 'connection not found' }, 404)

    const snapshot = await deps.pricing.get()
    const catalog = snapshot.catalog

    const srcProfile = settingsToProfile(srcRow, srcRow.settings)
    const src: Endpoint = { profile: srcProfile, rates: effectiveRates(srcProfile, catalog) }

    // 移動元自身も候補に残す。「同じ場所のままストレージクラスだけ変える」は
    // 実際の選択肢であり、その場合 egress も回線も要らない。
    const candidates = rows.map(row => {
      const profile = settingsToProfile(row, row.settings)
      return estimateTransfer({
        scan: scan.data,
        src,
        dst: { profile, rates: effectiveRates(profile, catalog) },
      })
    })

    const refreshDays = await readRefreshDays(deps.pools)
    const stale = isStale(snapshot, refreshDays, now())

    // 古ければ取り直しをジョブに投げる。**取得の完了は待たない** — 今回は
    // この単価のまま返し、更新は次回から効く (stale-while-revalidate)。
    // 外部 HTTP 2 往復を見積もりの応答時間に載せないため。料金改定は
    // 年 1〜2 回なので、1 回分古い単価で出しても桁は変わらない。
    if (stale && await shouldAutoRefresh(deps.store, refreshDays, now())) {
      // 投入自体は INSERT 1 本 (取得を待つわけではない) なので await してよい。
      // 失敗しても見積もりは返す — 単価の更新は見積もりの前提ではない。
      try {
        await deps.store.enqueue(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {})
      } catch (e) {
        console.error(JSON.stringify({ ev: 'pricing.autorefresh.failed', error: String(e) }))
      }
    }

    return c.json({
      source: {
        connId: srcProfile.connId,
        name: srcProfile.name,
        provider: srcProfile.provider,
        storageClass: srcProfile.storageClass,
        storageClassLabel: src.rates.storageClassLabel,
      },
      scan: {
        objectCount: scan.data.objectCount,
        totalBytes: scan.data.totalBytes,
        scannedAt: job.finishedAt,
      },
      catalog: {
        asOf: catalog.asOf,
        awsPublishedAt: catalog.awsPublishedAt,
        /** 'bundled' = まだ取得できていない (同梱の値で計算している)。 */
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt,
        stale,
        /** 取得しても更新されない値 (最小保存期間・Wasabi など) の出所。
         *  取得日が新しい = 全部新しい、と読み違えさせないために返す。 */
        manualFacts: catalog.manualFacts,
      },
      candidates,
    })
  })
}
