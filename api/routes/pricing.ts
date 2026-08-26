import type { Hono } from 'hono'
import type { Pools } from '../db.js'
import type { JobStore } from '../lib/jobs.js'
import type { CatalogSnapshot, PricingStore } from '../lib/pricing-store.js'

// 料金カタログの状態確認と更新 (spec: 2026-08-22-transfer-estimate-design.md)。
//
// 更新をジョブ基盤に載せているのは 2 つの理由から:
//   - 外部 HTTP がハングしても、ブラウザのリクエストを道連れにしない
//   - `jobs_active` の部分ユニークインデックスが同時実行を勝手に合流させる
//     (複数人が同時に「更新」を押しても 1 本になる)

export const PRICING_REFRESH_KIND = 'pricing.refresh'

/** カタログは Mado 全体で 1 つなので、対象を区別する必要がない。 */
export const PRICING_REFRESH_DEDUP_KEY = 'global'

/** キャッシュがこれより古ければ、見積もりを開いたついでに裏で取り直す。 */
export const DEFAULT_REFRESH_DAYS = 1

/** 更新間隔の設定キー (app_settings)。 */
export const REFRESH_DAYS_SETTING_KEY = 'pricing_refresh_days'

const MS_PER_DAY = 86_400_000

export async function readRefreshDays(pools: Pools): Promise<number> {
  try {
    const r = await pools.ro.query<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = $1', [REFRESH_DAYS_SETTING_KEY],
    )
    const n = Number(r.rows[0]?.value)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_REFRESH_DAYS
  } catch {
    return DEFAULT_REFRESH_DAYS
  }
}

/** 取り直すべきか。「まだ一度も取得していない」も古いとみなす。 */
export function isStale(snapshot: CatalogSnapshot, refreshDays: number, now: Date): boolean {
  if (snapshot.fetchedAt === null) return true
  const age = now.getTime() - Date.parse(snapshot.fetchedAt)
  return !(age < refreshDays * MS_PER_DAY)
}

/** 自動更新を投げてよいか。
 *
 *  **成功だけでなく失敗も間隔の対象にする。** 外に出られない環境では取得が
 *  必ず失敗するので、成功だけを見ていると見積もりを開くたびにジョブを積み、
 *  jobs テーブルが失敗で埋まる。最後の「試行」から間隔を測る。 */
export async function shouldAutoRefresh(
  store: JobStore, refreshDays: number, now: Date,
): Promise<boolean> {
  const last = await store.latestAny(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY)
  if (!last) return true
  if (last.status === 'queued' || last.status === 'running') return false
  const age = now.getTime() - Date.parse(last.finishedAt ?? last.createdAt)
  return !(age < refreshDays * MS_PER_DAY)
}

export interface PricingRoutesDeps {
  pools: Pools
  store: JobStore
  pricing: PricingStore
  now?: () => Date
}

export function mountPricingRoutes(app: Hono, deps: PricingRoutesDeps): void {
  const now = deps.now ?? ((): Date => new Date())

  // いま何の単価で計算しているか。出所 (同梱 / 取得日) を必ず返す —
  // 費用 0 が「無料」なのか「単価を引けていない」のかを画面で区別するため。
  app.get('/pricing', async c => {
    const snapshot = await deps.pricing.get()
    const refreshDays = await readRefreshDays(deps.pools)
    const job = await deps.store.activeOrLatest(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY)
    const last = await deps.store.latestAny(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY)

    return c.json({
      asOf: snapshot.catalog.asOf,
      awsPublishedAt: snapshot.catalog.awsPublishedAt,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      stale: isStale(snapshot, refreshDays, now()),
      refreshDays,
      regions: Object.keys(snapshot.catalog.aws.regions),
      /** 実行中か、最後に成功した更新ジョブ。 */
      job: job ? { id: job.id, status: job.status, progress: job.progress } : null,
      /** 直近の試行が失敗していれば理由を出す (外に出られない環境の切り分け用)。 */
      lastError: last && last.status === 'error' ? last.error : null,
    })
  })

  app.post('/pricing/refresh', async c => {
    const jobId = await deps.store.enqueue(
      PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {},
    )
    return c.json({ jobId })
  })
}
