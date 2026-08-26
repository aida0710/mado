import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createJobStore } from '../lib/jobs.js'
import { createPricingStore } from '../lib/pricing-store.js'
import { CATALOG } from '../pricing/catalog.js'
import {
  DEFAULT_REFRESH_DAYS, PRICING_REFRESH_DEDUP_KEY, PRICING_REFRESH_KIND,
  isStale, mountPricingRoutes, shouldAutoRefresh,
} from './pricing.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const store = createJobStore(pools)
const pricing = createPricingStore(pools, { memoTtlMs: 0 })

let today = new Date('2026-08-22T00:00:00Z')

const app = new Hono()
mountPricingRoutes(app, { pools, store, pricing, now: () => today })

interface PricingBody {
  asOf: string
  source: 'bundled' | 'fetched'
  fetchedAt: string | null
  stale: boolean
  refreshDays: number
  regions: string[]
  job: { id: number; status: string } | null
  lastError: string | null
}

beforeEach(async () => {
  today = new Date('2026-08-22T00:00:00Z')
  await pools.rw.query('TRUNCATE jobs RESTART IDENTITY')
  await pools.rw.query('TRUNCATE pricing_cache')
  await pools.rw.query('DELETE FROM app_settings WHERE key = $1', ['pricing_refresh_days'])
})
afterAll(() => closePools(pools))

describe('isStale', () => {
  const now = new Date('2026-08-22T00:00:00Z')

  it('取得していなければ古い扱い', () => {
    expect(isStale({ catalog: CATALOG, source: 'bundled', fetchedAt: null }, 1, now)).toBe(true)
  })

  it('間隔の内側なら新しい', () => {
    const s = { catalog: CATALOG, source: 'fetched' as const, fetchedAt: '2026-08-21T12:00:00Z' }
    expect(isStale(s, 1, now)).toBe(false)
  })

  it('間隔を超えたら古い', () => {
    const s = { catalog: CATALOG, source: 'fetched' as const, fetchedAt: '2026-08-20T00:00:00Z' }
    expect(isStale(s, 1, now)).toBe(true)
  })

  it('日時が壊れていたら古い扱いにする (NaN を新しい判定にしない)', () => {
    const s = { catalog: CATALOG, source: 'fetched' as const, fetchedAt: 'not-a-date' }
    expect(isStale(s, 1, now)).toBe(true)
  })
})

describe('shouldAutoRefresh', () => {
  const now = new Date('2026-08-22T00:00:00Z')

  it('一度も投げていなければ投げる', async () => {
    expect(await shouldAutoRefresh(store, 1, now)).toBe(true)
  })

  it('実行中なら投げない', async () => {
    await store.enqueue(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {})
    expect(await shouldAutoRefresh(store, 1, now)).toBe(false)
  })

  it('直近の成功から間隔が経っていなければ投げない', async () => {
    const id = await store.enqueue(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {})
    await store.claim()
    await store.finish(id, {})
    expect(await shouldAutoRefresh(store, 1, now)).toBe(false)
  })

  it('直近が失敗でも間隔は空ける', async () => {
    // 外に出られない環境で jobs が失敗で埋まるのを防ぐ。
    const id = await store.enqueue(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {})
    await store.claim()
    await store.fail(id, 'ENOTFOUND')
    const failed = await store.get(id)
    const finishedAt = new Date(failed!.finishedAt!)
    expect(await shouldAutoRefresh(store, 1, finishedAt)).toBe(false)
    // 間隔を過ぎれば投げ直す。
    expect(await shouldAutoRefresh(
      store, 1, new Date(finishedAt.getTime() + 2 * 86_400_000),
    )).toBe(true)
  })
})

describe('GET /pricing', () => {
  it('まだ取得していなければ同梱と伝える', async () => {
    const body = await (await app.request('/pricing')).json() as PricingBody
    expect(body.source).toBe('bundled')
    expect(body.fetchedAt).toBeNull()
    expect(body.asOf).toBe(CATALOG.asOf)
    expect(body.stale).toBe(true)
    expect(body.refreshDays).toBe(DEFAULT_REFRESH_DAYS)
    expect(body.regions).toContain('ap-northeast-1')
    expect(body.job).toBeNull()
  })

  it('取得済みなら日時と鮮度を返す', async () => {
    await pricing.save({ ...CATALOG, asOf: '2030-01-01' })
    const body = await (await app.request('/pricing')).json() as PricingBody
    expect(body.source).toBe('fetched')
    expect(body.asOf).toBe('2030-01-01')
    expect(body.fetchedAt).not.toBeNull()
  })

  it('更新間隔の設定を反映する', async () => {
    await pools.rw.query(
      `INSERT INTO app_settings (key, value) VALUES ('pricing_refresh_days', '30')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    )
    const body = await (await app.request('/pricing')).json() as PricingBody
    expect(body.refreshDays).toBe(30)
  })

  it('壊れた設定値は既定に倒す', async () => {
    await pools.rw.query(
      `INSERT INTO app_settings (key, value) VALUES ('pricing_refresh_days', 'soon')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    )
    const body = await (await app.request('/pricing')).json() as PricingBody
    expect(body.refreshDays).toBe(DEFAULT_REFRESH_DAYS)
  })

  it('実行中の更新を返す', async () => {
    await app.request('/pricing/refresh', { method: 'POST' })
    const body = await (await app.request('/pricing')).json() as PricingBody
    expect(body.job?.status).toBe('queued')
  })

  it('直近の更新が失敗していれば理由を返す', async () => {
    const id = await store.enqueue(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {})
    await store.claim()
    await store.fail(id, 'getaddrinfo ENOTFOUND pricing.us-east-1.amazonaws.com')

    const body = await (await app.request('/pricing')).json() as PricingBody
    // 外に出られない環境の切り分けに要る。
    expect(body.lastError).toContain('ENOTFOUND')
  })

  it('成功したあとは失敗の理由を残さない', async () => {
    const failed = await store.enqueue(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {})
    await store.claim()
    await store.fail(failed, 'ENOTFOUND')
    const ok = await store.enqueue(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {})
    await store.claim()
    await store.finish(ok, {})

    const body = await (await app.request('/pricing')).json() as PricingBody
    expect(body.lastError).toBeNull()
  })
})

describe('POST /pricing/refresh', () => {
  it('ジョブを投入する', async () => {
    const res = await app.request('/pricing/refresh', { method: 'POST' })
    expect(res.status).toBe(200)
    const { jobId } = await res.json() as { jobId: number }
    const job = await store.get(jobId)
    expect(job?.kind).toBe(PRICING_REFRESH_KIND)
    expect(job?.status).toBe('queued')
  })

  it('連打しても 1 本に合流する', async () => {
    const a = await app.request('/pricing/refresh', { method: 'POST' })
    const b = await app.request('/pricing/refresh', { method: 'POST' })
    const idA = (await a.json() as { jobId: number }).jobId
    const idB = (await b.json() as { jobId: number }).jobId
    expect(idB).toBe(idA)

    const r = await pools.ro.query<{ n: string }>(
      'SELECT count(*) AS n FROM jobs WHERE kind = $1', [PRICING_REFRESH_KIND],
    )
    expect(r.rows[0].n).toBe('1')
  })

  it('終わったジョブがあれば再投入できる', async () => {
    const first = await app.request('/pricing/refresh', { method: 'POST' })
    const idA = (await first.json() as { jobId: number }).jobId
    await store.claim()
    await store.finish(idA, {})

    const second = await app.request('/pricing/refresh', { method: 'POST' })
    const idB = (await second.json() as { jobId: number }).jobId
    expect(idB).not.toBe(idA)
  })
})
