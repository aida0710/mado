import type { Hono } from 'hono'
import { z } from 'zod'
import type { CapacityStore } from '../lib/capacity-store.js'
import type { ConnectionConfig } from '../storage.js'
import { markAuditNoChange } from '../lib/audit-activity.js'
import type { Pools } from '../db.js'
import { PRICING_SETTING_KEYS } from '../lib/pricing.js'
import type { JobStore } from '../lib/jobs.js'
import { enqueueCapacityScans } from '../lib/capacity-scheduler.js'

const Days = z.coerce.number().int().refine(value => [7, 30, 90, 400].includes(value))

export interface StorageCapacityDeps {
  store: CapacityStore
  jobs: Pick<JobStore, 'enqueueWithResult'>
  getConnectionConfig: (connId: string) => Promise<ConnectionConfig>
  listBuckets: (connId: string) => Promise<string[]>
  pools?: Pools
}

export function mountStorageCapacityRoutes(app: Hono, deps: StorageCapacityDeps): void {
  app.get('/storage/:connId/capacity', async c => {
    const parsedDays = Days.safeParse(c.req.query('days') ?? '90')
    if (!parsedDays.success) return c.json({ error: 'days must be one of 7, 30, 90, 400' }, 400)
    const connectionId = c.req.param('connId')
    const buckets = await deps.listBuckets(connectionId)
    const data = await deps.store.overview(connectionId, buckets, parsedDays.data)
    let capacityBytes: number | null = null
    if (deps.pools) {
      const setting = await deps.pools.ro.query<{ value: string }>(
        `SELECT value FROM connection_settings WHERE connection_id = $1 AND key = $2`,
        [connectionId, PRICING_SETTING_KEYS.capacityBytes],
      )
      const n = Number(setting.rows[0]?.value)
      if (Number.isSafeInteger(n) && n > 0) capacityBytes = n
    }
    return c.json({ connectionId, days: parsedDays.data, capacityBytes, ...data })
  })

  app.post('/storage/:connId/capacity/scan', async c => {
    const connectionId = c.req.param('connId')
    const config = await deps.getConnectionConfig(connectionId)
    if (!config.scanEnabled) return c.json({ error: 'この接続では走査が無効になっています' }, 403)

    const buckets = await deps.listBuckets(connectionId)
    const jobs = await enqueueCapacityScans({ capacity: deps.store, jobs: deps.jobs }, connectionId, buckets)
    if (jobs.every(job => !job.created)) markAuditNoChange(c)
    return c.json({ jobs: jobs.map(({ bucket, jobId }) => ({ bucket, jobId })) })
  })
}
