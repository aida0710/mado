import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { CATALOG } from '../pricing/catalog.js'
import { createPricingStore, looksLikeCatalog } from './pricing-store.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })

beforeEach(() => pools.rw.query('TRUNCATE pricing_cache'))
afterAll(() => closePools(pools))

describe('looksLikeCatalog', () => {
  it('同梱カタログは通る', () => {
    expect(looksLikeCatalog(CATALOG)).toBe(true)
  })

  it('null / プリミティブは弾く', () => {
    expect(looksLikeCatalog(null)).toBe(false)
    expect(looksLikeCatalog('{}')).toBe(false)
    expect(looksLikeCatalog(42)).toBe(false)
  })

  it('リージョンが空なら弾く', () => {
    expect(looksLikeCatalog({ ...CATALOG, aws: { regions: {} } })).toBe(false)
  })

  it('ストレージクラスが欠けていたら弾く', () => {
    // 構造を変えたあと古いキャッシュが残っている状態。読ませると単価 0 に
    // なり、「無料」と見分けが付かなくなる。
    const broken = structuredClone(CATALOG) as Record<string, never> & typeof CATALOG
    const region = broken.aws.regions['ap-northeast-1']
    delete (region.storageClasses as Partial<typeof region.storageClasses>).DEEP_ARCHIVE
    expect(looksLikeCatalog(broken)).toBe(false)
  })

  it('段が空のクラスがあれば弾く', () => {
    const broken = structuredClone(CATALOG)
    broken.aws.regions['ap-northeast-1'].storageClasses.STANDARD.storageTiers = []
    expect(looksLikeCatalog(broken)).toBe(false)
  })

  it('新しく足したフィールドが無い (= 古い形の) カタログを弾く', () => {
    // 構造を変えたあと古いキャッシュが残っている状態。undefined のまま
    // 計算に入ると NaN になるので、ここで弾いて同梱に落とすのが役目。
    const old = structuredClone(CATALOG) as {
      aws: { regions: Record<string, { storageClasses: Record<string, Record<string, unknown>> }> }
    }
    for (const region of Object.values(old.aws.regions)) {
      for (const cls of Object.values(region.storageClasses)) {
        delete cls.perObjectOverheadBytes
      }
    }
    expect(looksLikeCatalog(old)).toBe(false)
  })

  it('手入力の出所が無ければ弾く', () => {
    const old = structuredClone(CATALOG) as { manualFacts?: unknown }
    delete old.manualFacts
    expect(looksLikeCatalog(old)).toBe(false)
  })

  it('Wasabi の単価が無ければ弾く', () => {
    const broken = structuredClone(CATALOG) as { wasabi: { perTbMonthUsd?: number } }
    delete broken.wasabi.perTbMonthUsd
    expect(looksLikeCatalog(broken)).toBe(false)
  })
})

describe('createPricingStore', () => {
  it('まだ取得していなければ同梱を返す', async () => {
    const store = createPricingStore(pools, { memoTtlMs: 0 })
    const s = await store.get()
    expect(s.source).toBe('bundled')
    expect(s.fetchedAt).toBeNull()
    expect(s.catalog.asOf).toBe(CATALOG.asOf)
  })

  it('保存したものを返す', async () => {
    const store = createPricingStore(pools, { memoTtlMs: 0 })
    await store.save({ ...CATALOG, asOf: '2030-01-01' })

    const s = await store.get()
    expect(s.source).toBe('fetched')
    expect(s.catalog.asOf).toBe('2030-01-01')
    expect(s.fetchedAt).not.toBeNull()
  })

  it('保存は上書きする (常に 1 行)', async () => {
    const store = createPricingStore(pools, { memoTtlMs: 0 })
    await store.save({ ...CATALOG, asOf: '2030-01-01' })
    await store.save({ ...CATALOG, asOf: '2030-06-01' })

    const r = await pools.ro.query<{ n: string }>('SELECT count(*) AS n FROM pricing_cache')
    expect(r.rows[0].n).toBe('1')
    expect((await store.get()).catalog.asOf).toBe('2030-06-01')
  })

  it('壊れたキャッシュは同梱に落とす', async () => {
    await pools.rw.query(
      `INSERT INTO pricing_cache (id, catalog) VALUES (TRUE, $1)`,
      [JSON.stringify({ asOf: '2030-01-01', aws: { regions: {} }, wasabi: {} })],
    )
    const store = createPricingStore(pools, { memoTtlMs: 0 })
    const s = await store.get()
    // 0 と表示して「無料」に見せるより、同梱の値で出して出所を伝える。
    expect(s.source).toBe('bundled')
    expect(s.catalog.asOf).toBe(CATALOG.asOf)
  })

  it('メモ化している間は DB を見に行かない', async () => {
    const store = createPricingStore(pools, { memoTtlMs: 60_000 })
    expect((await store.get()).source).toBe('bundled')

    // 直接 INSERT してもメモが生きている間は見えない。
    await pools.rw.query(
      `INSERT INTO pricing_cache (id, catalog) VALUES (TRUE, $1)`,
      [JSON.stringify({ ...CATALOG, asOf: '2030-01-01' })],
    )
    expect((await store.get()).source).toBe('bundled')

    store.invalidate()
    expect((await store.get()).catalog.asOf).toBe('2030-01-01')
  })

  it('保存するとメモが捨てられる', async () => {
    const store = createPricingStore(pools, { memoTtlMs: 60_000 })
    expect((await store.get()).source).toBe('bundled')
    await store.save({ ...CATALOG, asOf: '2030-01-01' })
    expect((await store.get()).catalog.asOf).toBe('2030-01-01')
  })

  it('メモの寿命が切れたら読み直す', async () => {
    let clock = 1000
    const store = createPricingStore(pools, { memoTtlMs: 500, now: () => clock })
    expect((await store.get()).source).toBe('bundled')

    await pools.rw.query(
      `INSERT INTO pricing_cache (id, catalog) VALUES (TRUE, $1)`,
      [JSON.stringify({ ...CATALOG, asOf: '2030-01-01' })],
    )
    clock += 400
    expect((await store.get()).source).toBe('bundled')
    clock += 200
    expect((await store.get()).source).toBe('fetched')
  })

  it('DB が読めなくても同梱で返す (見積もりを落とさない)', async () => {
    const broken = {
      ro: { query: () => Promise.reject(new Error('db down')) },
      rw: pools.rw,
    } as unknown as typeof pools
    const store = createPricingStore(broken, { memoTtlMs: 0 })
    const s = await store.get()
    expect(s.source).toBe('bundled')
  })
})
