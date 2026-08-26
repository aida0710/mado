import type { JobContext, JobHandler } from './job-runner.js'
import { fetchCatalog, FETCH_REGIONS, type FetchCatalogOptions } from './pricing-fetch.js'
import type { PricingStore } from './pricing-store.js'

// pricing.refresh ハンドラ (spec: 2026-08-22-transfer-estimate-design.md)。
//
// 失敗しても既存のキャッシュには触らない。取得できなかったときに古い単価が
// 消えて費用が 0 になる方が、単価が 1 回分古いより危険なため。

export interface PricingRefreshDeps {
  store: PricingStore
  /** テストから fetch を差し替える。 */
  fetchImpl?: FetchCatalogOptions['fetchImpl']
  timeoutMs?: number
}

export function createPricingRefreshHandler(deps: PricingRefreshDeps): JobHandler {
  return async (ctx: JobContext) => {
    // 分母は「料金表 1 + リージョン数」。走査と違って総数が最初から分かる。
    const total = FETCH_REGIONS.length + 1
    let done = 0

    const catalog = await fetchCatalog({
      signal: ctx.signal,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs,
      onProgress: label => {
        ctx.setProgress({ kind: 'ratio', done, total, label })
        done += 1
      },
    })

    await deps.store.save(catalog)

    // カタログ本体は jobs.result に入れない (数百 KB が毎回積み上がる)。
    return {
      asOf: catalog.asOf,
      awsPublishedAt: catalog.awsPublishedAt,
      regions: Object.keys(catalog.aws.regions),
    }
  }
}
