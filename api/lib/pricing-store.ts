// 料金カタログの読み書き (spec: 2026-08-22-transfer-estimate-design.md)。
//
// 3 層になっている:
//
//   プロセス内メモリ (60 秒) → pricing_cache (DB) → 同梱の pricing/catalog.ts
//
// **どの層も失敗しても見積もりは出る。** DB が落ちていようが、キャッシュが
// 古いスキーマだろうが、同梱カタログに落ちるだけ。単価が引けないことと
// 無料であることを取り違えさせないため、出所 (source) を必ず一緒に返す。

import type { Pools } from '../db.js'
import { CATALOG } from '../pricing/catalog.js'
import type { PricingCatalog } from './pricing-types.js'
import { STORAGE_CLASS_KEYS } from './pricing-types.js'

export type CatalogSource = 'bundled' | 'fetched'

export interface CatalogSnapshot {
  catalog: PricingCatalog
  source: CatalogSource
  /** 取得した日時 (ISO)。同梱を使っているときは null。 */
  fetchedAt: string | null
}

export interface PricingStore {
  /** いま使うカタログ。DB が読めなければ同梱に落ちる (throw しない)。 */
  get(): Promise<CatalogSnapshot>
  save(catalog: PricingCatalog): Promise<void>
  /** メモリキャッシュを捨てる。保存した直後に呼ぶ。 */
  invalidate(): void
}

const BUNDLED: CatalogSnapshot = { catalog: CATALOG, source: 'bundled', fetchedAt: null }

/** DB に入っているカタログの形をざっと確かめる。
 *
 *  カタログの構造を変えたあと古いキャッシュが残っていると、undefined を
 *  読んで見積もりが 0 になる — 単価 0 は「無料」と見分けが付かないので、
 *  形が合わなければ同梱に落として出所を `bundled` と伝える方が安全。 */
export function looksLikeCatalog(v: unknown): v is PricingCatalog {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Partial<PricingCatalog>
  if (typeof c.asOf !== 'string') return false
  if (typeof c.wasabi?.perTbMonthUsd !== 'number') return false

  const regions = c.aws?.regions
  if (typeof regions !== 'object' || regions === null) return false
  const entries = Object.values(regions)
  if (entries.length === 0) return false

  return entries.every(r =>
    Array.isArray(r?.egressTiers) &&
    STORAGE_CLASS_KEYS.every(k => {
      const cls = r.storageClasses?.[k]
      return Array.isArray(cls?.storageTiers)
        && cls.storageTiers.length > 0
        && typeof cls.putPer1000 === 'number'
    }))
}

export interface PricingStoreOptions {
  /** メモリキャッシュの寿命。既定 60 秒。 */
  memoTtlMs?: number
  now?: () => number
}

interface DbRow {
  catalog: unknown
  fetched_at: Date
}

export function createPricingStore(pools: Pools, opts: PricingStoreOptions = {}): PricingStore {
  const ttl = opts.memoTtlMs ?? 60_000
  const now = opts.now ?? ((): number => Date.now())

  let memo: CatalogSnapshot | null = null
  let memoAt = -Infinity

  return {
    async get() {
      if (memo && now() - memoAt < ttl) return memo

      let snapshot = BUNDLED
      try {
        const r = await pools.ro.query<DbRow>(
          'SELECT catalog, fetched_at FROM pricing_cache WHERE id',
        )
        const row = r.rows[0]
        if (row && looksLikeCatalog(row.catalog)) {
          snapshot = {
            catalog: row.catalog,
            source: 'fetched',
            fetchedAt: row.fetched_at.toISOString(),
          }
        } else if (row) {
          console.error(JSON.stringify({
            ev: 'pricing.cache.malformed',
            hint: '同梱カタログにフォールバックしました。単価を更新してください',
          }))
        }
      } catch (e) {
        // 見積もりは単価が無くても形になる。DB の不調で画面を落とさない。
        console.error(JSON.stringify({
          ev: 'pricing.cache.read_failed', error: String(e),
        }))
      }

      memo = snapshot
      memoAt = now()
      return snapshot
    },

    async save(catalog) {
      await pools.rw.query(
        `INSERT INTO pricing_cache (id, catalog, fetched_at) VALUES (TRUE, $1, now())
         ON CONFLICT (id) DO UPDATE SET catalog = EXCLUDED.catalog, fetched_at = now()`,
        [JSON.stringify(catalog)],
      )
      memo = null
      memoAt = -Infinity
    },

    invalidate() {
      memo = null
      memoAt = -Infinity
    },
  }
}
