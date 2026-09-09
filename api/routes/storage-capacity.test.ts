import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountStorageCapacityRoutes } from './storage-capacity.js'
import type { CapacityStore } from '../lib/capacity-store.js'
import type { ConnectionConfig } from '../storage.js'
import type { JobStore } from '../lib/jobs.js'

const overview = vi.fn()
const syncBuckets = vi.fn()
const attachJob = vi.fn()
const enqueueWithResult = vi.fn()
const listBuckets = vi.fn()
let scanEnabled = true
const store = { overview, syncBuckets, attachJob } as unknown as CapacityStore
const app = new Hono()
mountStorageCapacityRoutes(app, {
  store,
  jobs: { enqueueWithResult } as Pick<JobStore, 'enqueueWithResult'>,
  getConnectionConfig: async () => ({ scanEnabled } as ConnectionConfig),
  listBuckets,
})

beforeEach(() => {
  overview.mockReset().mockResolvedValue({
    tracking: { enabled: false, intervalSeconds: 86400 }, buckets: [],
  })
  syncBuckets.mockReset().mockResolvedValue(undefined)
  attachJob.mockReset().mockResolvedValue(undefined)
  enqueueWithResult.mockReset().mockResolvedValue({ id: 7, created: true })
  listBuckets.mockReset().mockResolvedValue(['archive', 'data'])
  scanEnabled = true
})

describe('storage capacity routes', () => {
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

  it('走査無効接続では一括計測を開始しない', async () => {
    scanEnabled = false
    const response = await app.request('/storage/c1/capacity/scan', { method: 'POST' })
    expect(response.status).toBe(403)
    expect(listBuckets).not.toHaveBeenCalled()
    expect(enqueueWithResult).not.toHaveBeenCalled()
  })
})
