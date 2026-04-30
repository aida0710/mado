import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { Pools } from '../db.js'
import { requireWriteToken } from '../auth.js'
import { HpcResponseSchema } from '../shared/types.js'

const HpcRowFromDb = z.object({
  host: z.string(),
  command: z.string(),
  category: z.string(),
  output: z.string(),
  collected_at: z.date(),
})

// Only show metrics from the last hour — older rows mean the cron stopped.
const FRESHNESS_INTERVAL = '1 hour'

export interface HpcDeps {
  pools: Pools
  writeToken: string
}

const PUSH_BODY_LIMIT = 1_000_000

export function mountHpcRoutes(app: Hono, deps: HpcDeps): void {
  app.post(
    '/api/hpc/push',
    requireWriteToken(deps.writeToken),
    bodyLimit({
      maxSize: PUSH_BODY_LIMIT,
      onError: c => c.json({ error: 'request body too large' }, 413),
    }),
    async c => {
      const host = c.req.query('host')
      const command = c.req.query('command')
      const category = c.req.query('category') ?? 'general'
      if (!host || !command) {
        return c.json({ error: 'host and command query params are required' }, 400)
      }
      const output = await c.req.text()
      await deps.pools.rw.query(
        `INSERT INTO hpc_metrics(host, command, category, output)
         VALUES ($1, $2, $3, $4)`,
        [host, command, category, output]
      )
      return c.json({ ok: true })
    },
  )

  app.get('/api/hpc', async c => {
    const r = await deps.pools.ro.query(
      `SELECT host, command, category, output, collected_at
         FROM hpc_metrics_latest
         WHERE collected_at >= now() - interval '${FRESHNESS_INTERVAL}'
         ORDER BY category, host, command`
    )
    const rows = r.rows.map(raw => {
      const row = HpcRowFromDb.parse(raw)
      return { ...row, collected_at: row.collected_at.toISOString() }
    })
    return c.json(HpcResponseSchema.parse(rows))
  })
}
