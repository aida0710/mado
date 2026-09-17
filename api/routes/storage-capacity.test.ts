import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountStorageCapacityRoutes } from './storage-capacity.js'
import type { CapacityStore } from '../lib/capacity-store.js'
import type { ConnectionConfig } from '../storage.js'
import type { JobStore } from '../lib/jobs.js'

const overview = vi.fn()
const syncBuckets = vi.fn()
const attachJob = vi.fn()
const scanActivity = vi.fn()
const enqueueWithResult = vi.fn()
const listBuckets = vi.fn()
let scanEnabled = true
let capacityMetricsEnabled = true
const store = { overview, syncBuckets, attachJob, scanActivity } as unknown as CapacityStore
const app = new Hono()
mountStorageCapacityRoutes(app, {
  store,
  jobs: { enqueueWithResult } as Pick<JobStore, 'enqueueWithResult'>,
  getConnectionConfig: async () => ({ scanEnabled, capacityMetricsEnabled } as ConnectionConfig),
  listBuckets,
})

beforeEach(() => {
  overview.mockReset().mockResolvedValue({
    tracking: { enabled: false, intervalSeconds: 86400 }, scan: { jobs: [] }, buckets: [],
  })
  syncBuckets.mockReset().mockResolvedValue(undefined)
  attachJob.mockReset().mockResolvedValue(undefined)
  scanActivity.mockReset().mockResolvedValue({ jobs: [] })
  enqueueWithResult.mockReset().mockResolvedValue({ id: 7, created: true })
  listBuckets.mockReset().mockResolvedValue(['archive', 'data'])
  scanEnabled = true
  capacityMetricsEnabled = true
})

describe('容量メトリクス route', () => {
  it('全bucketの指定期間履歴を1回で返す', async () => {
    const response = await app.request('/storage/c1/capacity?days=90')
    expect(response.status).toBe(200)
    expect(overview).toHaveBeenCalledWith('c1', ['archive', 'data'], 90)
    expect(await response.json()).toMatchObject({ connectionId: 'c1', days: 90 })
  })

  it('未対応期間を拒否する', async () => {
    expect((await app.request('/storage/c1/capacity?days=31')).status).toBe(400)
  })

  it('全bucketの走査を一括投入する', async () => {
    const response = await app.request('/storage/c1/capacity/scan', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(syncBuckets).toHaveBeenCalledWith('c1', ['archive', 'data'])
    expect(enqueueWithResult).toHaveBeenCalledTimes(2)
    expect((await response.json()).jobs).toEqual([
      { bucket: 'archive', jobId: 7 }, { bucket: 'data', jobId: 7 },
    ])
  })

  it('同じconnectionの計測が進行中なら再実行を拒否する', async () => {
    scanActivity.mockResolvedValue({
      jobs: [{
        jobId: 6, bucket: 'archive', status: 'running', objectCount: 100,
        createdAt: '2026-09-10T00:00:00Z', startedAt: '2026-09-10T00:01:00Z',
      }],
    })
    const response = await app.request('/storage/c1/capacity/scan', { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'この接続のバケット計測はすでに進行中です' })
    expect(listBuckets).not.toHaveBeenCalled()
    expect(enqueueWithResult).not.toHaveBeenCalled()
  })

  it('走査無効接続では一括計測を開始しない', async () => {
    scanEnabled = false
    const response = await app.request('/storage/c1/capacity/scan', { method: 'POST' })
    expect(response.status).toBe(403)
    expect(listBuckets).not.toHaveBeenCalled()
    expect(enqueueWithResult).not.toHaveBeenCalled()
  })

  it('メトリクス集計無効接続では一括計測を開始しない', async () => {
    capacityMetricsEnabled = false
    const response = await app.request('/storage/c1/capacity/scan', { method: 'POST' })
    expect(response.status).toBe(403)
    expect(listBuckets).not.toHaveBeenCalled()
    expect(enqueueWithResult).not.toHaveBeenCalled()
  })
})
