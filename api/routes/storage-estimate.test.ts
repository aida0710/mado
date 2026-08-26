import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createJobStore } from '../lib/jobs.js'
import { createPricingStore } from '../lib/pricing-store.js'
import { CATALOG, PRICING_SETTING_KEYS as K } from '../lib/pricing.js'
import { mountStorageEstimateRoutes } from './storage-estimate.js'
import { SCAN_KIND, scanDedupKey } from './storage-scan.js'
import { PRICING_REFRESH_DEDUP_KEY, PRICING_REFRESH_KIND } from './pricing.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const RO = RW.replace('dashboard_rw', 'dashboard_ro')
const pools = createPools({ rw: RW, ro: RO })
const store = createJobStore(pools)
// メモ化を切る (テストごとに pricing_cache を書き換えるため)。
const pricing = createPricingStore(pools, { memoTtlMs: 0 })

// カタログの古さ判定を確かめられるよう「今日」を差し込む。
let today = new Date('2026-08-22T00:00:00Z')

const app = new Hono()
mountStorageEstimateRoutes(app, { pools, store, pricing, now: () => today })

const GIB = 1024 ** 3

interface Candidate {
  connId: string
  name: string
  provider: string
  storageClass: string | null
  sameConnection: boolean
  durationSec: { optimistic: number; pessimistic: number }
  upfront: { egress: number; retrieval: number; getRequests: number; putRequests: number; total: number }
  monthlyUsd: number
  warnings: Array<{ kind: string; message: string }>
}

interface EstimateBody {
  source: { connId: string; name: string; provider: string }
  scan: { objectCount: number; totalBytes: number; scannedAt: string | null }
  catalog: { asOf: string; stale: boolean; source: 'bundled' | 'fetched'; fetchedAt: string | null }
  candidates: Candidate[]
}

async function addConnection(
  id: string,
  name: string,
  endpoint: string,
  region = 'auto',
  settings: Record<string, string> = {},
): Promise<void> {
  await pools.rw.query(
    `INSERT INTO storage_connections
       (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc,
        access_key_id_masked, force_path_style, list_objects_version)
     VALUES ($1, $2, $3, $4, 'enc', 'enc', 'AKIA…MASK', true, 'v2')`,
    [id, name, endpoint, region],
  )
  for (const [key, value] of Object.entries(settings)) {
    await pools.rw.query(
      `INSERT INTO connection_settings (connection_id, key, value) VALUES ($1, $2, $3)`,
      [id, key, value],
    )
  }
}

/** 完了済みの走査ジョブを 1 本置く。 */
async function addScan(
  connId: string, bucket: string, prefix: string,
  result: { objectCount: number; totalBytes: number },
): Promise<void> {
  const id = await store.enqueue(SCAN_KIND, scanDedupKey(connId, bucket, prefix), {
    connId, bucket, prefix,
  })
  await store.claim()
  await store.finish(id, { ...result, children: [], extensions: [], partial: false })
}

/** pricing_cache に取得済みカタログを置く。中身は同梱と同じで、日時だけ指定する。 */
async function setCachedCatalog(fetchedAt: string): Promise<void> {
  await pools.rw.query(
    `INSERT INTO pricing_cache (id, catalog, fetched_at) VALUES (TRUE, $1, $2)
     ON CONFLICT (id) DO UPDATE
       SET catalog = EXCLUDED.catalog, fetched_at = EXCLUDED.fetched_at`,
    [JSON.stringify(CATALOG), fetchedAt],
  )
}

async function refreshJobs(): Promise<Array<{ status: string }>> {
  const r = await pools.ro.query<{ status: string }>(
    'SELECT status FROM jobs WHERE kind = $1', [PRICING_REFRESH_KIND],
  )
  return r.rows
}

function get(connId: string, query = 'bucket=b&prefix=d/'): Promise<Response> {
  return app.request(`/storage/${connId}/estimate?${query}`)
}

beforeEach(async () => {
  today = new Date('2026-08-22T00:00:00Z')
  await pools.rw.query('TRUNCATE storage_connections CASCADE')
  await pools.rw.query('TRUNCATE jobs RESTART IDENTITY')
  await pools.rw.query('TRUNCATE pricing_cache')
  await pools.rw.query('DELETE FROM app_settings WHERE key = $1', ['pricing_refresh_days'])
})
afterAll(() => closePools(pools))

describe('GET /storage/:connId/estimate', () => {
  it('bucket が無ければ 400', async () => {
    await addConnection('c1'.padEnd(10, '0'), 'src', 'https://minio.lan:9000')
    const res = await get('c1'.padEnd(10, '0'), 'prefix=d/')
    expect(res.status).toBe(400)
  })

  it('走査していなければ 409', async () => {
    const id = 'c1'.padEnd(10, '0')
    await addConnection(id, 'src', 'https://minio.lan:9000')
    const res = await get(id)
    expect(res.status).toBe(409)
    expect((await res.json() as { error: string }).error).toContain('走査')
  })

  it('走査があれば登録済み接続ぶんの候補が返る', async () => {
    const src = 'src'.padEnd(10, '0')
    const dst = 'dst'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addConnection(dst, 'jamstec-s3', 'https://jamstec.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 1000, totalBytes: 100 * GIB })

    const res = await get(src)
    expect(res.status).toBe(200)
    const body = await res.json() as EstimateBody

    expect(body.source.name).toBe('mdx-s3')
    expect(body.source.provider).toBe('onprem')
    expect(body.scan.objectCount).toBe(1000)
    expect(body.scan.scannedAt).not.toBeNull()
    expect(body.candidates).toHaveLength(2)
    expect(body.candidates.map(c => c.name).sort()).toEqual(['jamstec-s3', 'mdx-s3'])
  })

  it('移動元自身も候補に残り、同一接続の印が立つ', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 10, totalBytes: 10 * GIB })

    const body = await (await get(src)).json() as EstimateBody
    const self = body.candidates.find(c => c.connId === src)
    expect(self?.sameConnection).toBe(true)
  })

  it('接続が無ければ 404', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    // 走査だけ別 ID に対して置く (409 ではなく 404 を確かめるため)。
    const ghost = 'gho'.padEnd(10, '0')
    await addScan(ghost, 'b', 'd/', { objectCount: 1, totalBytes: 1 })
    const res = await get(ghost)
    expect(res.status).toBe(404)
  })

  it('社内 → AWS では egress が無く、月額とリクエスト料金が乗る', async () => {
    const src = 'src'.padEnd(10, '0')
    const aws = 'aws'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addConnection(aws, 'aws-s3', 'https://s3.ap-northeast-1.amazonaws.com', 'ap-northeast-1')
    await addScan(src, 'b', 'd/', { objectCount: 100_000, totalBytes: 10 * 1024 * GIB })

    const body = await (await get(src)).json() as EstimateBody
    const c = body.candidates.find(x => x.connId === aws)!
    expect(c.provider).toBe('aws')
    expect(c.storageClass).toBe('STANDARD')
    expect(c.upfront.egress).toBe(0)
    expect(c.upfront.putRequests).toBeGreaterThan(0)
    // 10TiB × $0.025/GB ≒ $256
    expect(c.monthlyUsd).toBeGreaterThan(200)
    expect(c.monthlyUsd).toBeLessThan(300)
  })

  it('AWS → 社内では egress が乗る', async () => {
    const aws = 'aws'.padEnd(10, '0')
    const lan = 'lan'.padEnd(10, '0')
    await addConnection(aws, 'aws-s3', 'https://s3.ap-northeast-1.amazonaws.com', 'ap-northeast-1')
    await addConnection(lan, 'jamstec-s3', 'https://jamstec.lan:9000')
    await addScan(aws, 'b', 'd/', { objectCount: 1000, totalBytes: 1024 * GIB })

    const body = await (await get(aws)).json() as EstimateBody
    const c = body.candidates.find(x => x.connId === lan)!
    // 1TiB - 無料枠 100GB = 924GB が第 1 段 ($0.114)。
    expect(c.upfront.egress).toBeCloseTo(924 * 0.114, 0)
    expect(c.monthlyUsd).toBe(0)
  })

  it('ストレージクラスの設定が候補に反映される', async () => {
    const src = 'src'.padEnd(10, '0')
    const gda = 'gda'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addConnection(gda, 'aws-cold', 'https://s3.ap-northeast-1.amazonaws.com', 'ap-northeast-1', {
      [K.storageClass]: 'DEEP_ARCHIVE',
    })
    await addScan(src, 'b', 'd/', { objectCount: 1000, totalBytes: 1024 * GIB })

    const body = await (await get(src)).json() as EstimateBody
    const c = body.candidates.find(x => x.connId === gda)!
    expect(c.storageClass).toBe('DEEP_ARCHIVE')
    expect(c.warnings.map(w => w.kind)).toContain('minDuration')
    expect(c.warnings.map(w => w.kind)).toContain('archiveRetrievalTime')
    // 1TiB × $0.002 ≒ $2
    expect(c.monthlyUsd).toBeCloseTo(1024 * 0.002, 1)
  })

  it('接続設定の実測帯域が所要時間に効く', async () => {
    const src = 'src'.padEnd(10, '0')
    const slow = 'slw'.padEnd(10, '0')
    const fast = 'fst'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000', 'auto', {
      [K.readMbps]: '1000', [K.instability]: '0',
    })
    await addConnection(slow, 'slow', 'https://slow.lan:9000', 'auto', {
      [K.writeMbps]: '100', [K.instability]: '0',
    })
    await addConnection(fast, 'fast', 'https://fast.lan:9000', 'auto', {
      [K.writeMbps]: '700', [K.instability]: '0',
    })
    await addScan(src, 'b', 'd/', { objectCount: 100, totalBytes: 700_000_000_000 })

    const body = await (await get(src)).json() as EstimateBody
    const s = body.candidates.find(x => x.connId === slow)!
    const f = body.candidates.find(x => x.connId === fast)!
    expect(s.durationSec.optimistic).toBeCloseTo(7000, 0)
    expect(f.durationSec.optimistic).toBeCloseTo(1000, 0)
  })

  it('まだ取得していなければ同梱カタログで計算し、古い扱いにする', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 1, totalBytes: 1 })

    const body = await (await get(src)).json() as EstimateBody
    expect(body.catalog.source).toBe('bundled')
    expect(body.catalog.fetchedAt).toBeNull()
    expect(body.catalog.asOf).toBe(CATALOG.asOf)
    // 同梱は「まだ一度も取得していない」なので、更新を促す。
    expect(body.catalog.stale).toBe(true)
  })

  it('取得済みなら取得日時と鮮度を返す', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 1, totalBytes: 1 })
    await setCachedCatalog('2026-08-22T00:00:00Z')

    today = new Date('2026-08-22T06:00:00Z')
    const fresh = await (await get(src)).json() as EstimateBody
    expect(fresh.catalog.source).toBe('fetched')
    expect(fresh.catalog.fetchedAt).toBe('2026-08-22T00:00:00.000Z')
    expect(fresh.catalog.stale).toBe(false)

    // 既定の更新間隔は 1 日。
    today = new Date('2026-08-24T00:00:00Z')
    const stale = await (await get(src)).json() as EstimateBody
    expect(stale.catalog.stale).toBe(true)
  })

  it('更新間隔は app_settings で変えられる', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 1, totalBytes: 1 })
    await setCachedCatalog('2026-08-22T00:00:00Z')
    await pools.rw.query(
      `INSERT INTO app_settings (key, value) VALUES ('pricing_refresh_days', '30')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    )

    today = new Date('2026-08-24T00:00:00Z')
    const body = await (await get(src)).json() as EstimateBody
    expect(body.catalog.stale).toBe(false)
  })

  it('古ければ裏で更新ジョブを投げる (見積もりは待たずに返す)', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 1, totalBytes: 1 })

    const body = await (await get(src)).json() as EstimateBody
    // 今回の見積もりは古い単価のまま返る (stale-while-revalidate)。
    expect(body.catalog.source).toBe('bundled')
    expect(await refreshJobs()).toHaveLength(1)
  })

  it('更新が実行中なら重ねて投げない', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 1, totalBytes: 1 })

    await get(src)
    expect(await refreshJobs()).toHaveLength(1)
    await get(src)
    await get(src)
    expect(await refreshJobs()).toHaveLength(1)
  })

  it('新しければ更新ジョブを投げない', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 1, totalBytes: 1 })
    await setCachedCatalog('2026-08-22T00:00:00Z')

    today = new Date('2026-08-22T06:00:00Z')
    await get(src)
    expect(await refreshJobs()).toHaveLength(0)
  })

  it('直近の更新が失敗していても、間隔を空けるまで投げ直さない', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'd/', { objectCount: 1, totalBytes: 1 })

    // 外に出られない環境では取得が必ず失敗する。見積もりを開くたびに
    // ジョブを積むと jobs が失敗で埋まるので、失敗も間隔の対象にする。
    const id = await store.enqueue(PRICING_REFRESH_KIND, PRICING_REFRESH_DEDUP_KEY, {})
    await store.claim()
    await store.fail(id, 'getaddrinfo ENOTFOUND')
    const failed = await store.get(id)
    today = new Date(failed!.finishedAt!)

    await get(src)
    expect(await refreshJobs()).toHaveLength(1)

    // 1 日経てば投げ直す。
    today = new Date(today.getTime() + 2 * 86_400_000)
    await get(src)
    expect(await refreshJobs()).toHaveLength(2)
  })

  it('走査は prefix ごとに別のものを引く', async () => {
    const src = 'src'.padEnd(10, '0')
    await addConnection(src, 'mdx-s3', 'https://mdx.lan:9000')
    await addScan(src, 'b', 'a/', { objectCount: 111, totalBytes: 1 * GIB })
    await addScan(src, 'b', 'z/', { objectCount: 999, totalBytes: 9 * GIB })

    const a = await (await get(src, 'bucket=b&prefix=a/')).json() as EstimateBody
    const z = await (await get(src, 'bucket=b&prefix=z/')).json() as EstimateBody
    expect(a.scan.objectCount).toBe(111)
    expect(z.scan.objectCount).toBe(999)
  })
})
