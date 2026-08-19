import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { mountStorageScanRoutes, scanDedupKey, SCAN_KIND } from './storage-scan.js'
import type { JobStore } from '../lib/jobs.js'
import { DEFAULT_BUCKET_SETTINGS } from '../lib/bucket-settings.js'

let enqueued: Array<[string, string, unknown]> = []
let scanEnabled = true

const store = {
  enqueue: async (kind: string, dedupKey: string, payload: unknown) => {
    enqueued.push([kind, dedupKey, payload])
    return 7
  },
} as unknown as JobStore

const app = new Hono()
mountStorageScanRoutes(app, {
  store,
  bucketSettings: { get: async () => ({ ...DEFAULT_BUCKET_SETTINGS, scanEnabled }) },
})

beforeEach(() => { enqueued = []; scanEnabled = true })

describe('POST /storage/:connId/scan', () => {
  it('ジョブを投入して id を返す', async () => {
    const res = await app.request('/storage/c1/scan?bucket=b1&prefix=p/', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobId: 7 })
    expect(enqueued).toEqual([[SCAN_KIND, scanDedupKey('c1', 'b1', 'p/'), {
      connId: 'c1', bucket: 'b1', prefix: 'p/',
    }]])
  })

  it('prefix 省略はバケット root として扱う', async () => {
    await app.request('/storage/c1/scan?bucket=b1', { method: 'POST' })
    expect(enqueued[0][2]).toEqual({ connId: 'c1', bucket: 'b1', prefix: '' })
  })

  it('bucket が無ければ 400', async () => {
    expect((await app.request('/storage/c1/scan', { method: 'POST' })).status).toBe(400)
  })

  it('scan_enabled=false なら 403 で投入しない', async () => {
    scanEnabled = false
    const res = await app.request('/storage/c1/scan?bucket=b1&prefix=p/', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(enqueued).toHaveLength(0)
  })
})
