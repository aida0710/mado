import type { Hono } from 'hono'
import { z } from 'zod'
import type { CapacityStore } from '../lib/capacity-store.js'
import { CAPACITY_INTERVALS } from '../lib/capacity-store.js'
import type { ConnectionConfig } from '../storage.js'
import { getSessionPrincipal } from '../lib/rbac.js'
import { markAuditNoChange } from '../lib/audit-activity.js'
import type { Pools } from '../db.js'
import { PRICING_SETTING_KEYS } from '../lib/pricing.js'

const Days = z.coerce.number().int().refine(value => [7, 30, 90, 400].includes(value))
const TrackingInput = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().refine(value => CAPACITY_INTERVALS.includes(value as never)),
}).strict()

export interface StorageCapacityDeps {
  store: CapacityStore
  getConnectionConfig: (connId: string) => Promise<ConnectionConfig>
  pools?: Pools
}

export function mountStorageCapacityRoutes(app: Hono, deps: StorageCapacityDeps): void {
  app.get('/storage/:connId/capacity', async c => {
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const parsedDays = Days.safeParse(c.req.query('days') ?? '90')
    if (!parsedDays.success) return c.json({ error: 'days must be one of 7, 30, 90, 400' }, 400)
    const data = await deps.store.history(c.req.param('connId'), bucket, parsedDays.data)
    let capacityBytes: number | null = null
    if (deps.pools) {
      const setting = await deps.pools.ro.query<{ value: string }>(
        `SELECT value FROM connection_settings WHERE connection_id = $1 AND key = $2`,
        [c.req.param('connId'), PRICING_SETTING_KEYS.capacityBytes],
      )
      const n = Number(setting.rows[0]?.value)
      if (Number.isSafeInteger(n) && n > 0) capacityBytes = n
    }
    return c.json({
      connectionId: c.req.param('connId'), bucket, days: parsedDays.data, capacityBytes, ...data,
    })
  })

  app.put('/storage/:connId/capacity/tracking', async c => {
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const input = TrackingInput.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return c.json({ error: 'enabled and a supported intervalSeconds are required' }, 400)

    if (input.data.enabled) {
      const config = await deps.getConnectionConfig(c.req.param('connId'))
      if (!config.scanEnabled) {
        return c.json({ error: 'この接続では走査が無効になっています' }, 409)
      }
    }

    const userId = getSessionPrincipal(c)?.user.id ?? null
    const result = await deps.store.setTracking(
      c.req.param('connId'), bucket, input.data.enabled, input.data.intervalSeconds, userId,
    )
    if (!result.changed) markAuditNoChange(c)
    return c.json({ tracking: result.tracking })
  })
}
