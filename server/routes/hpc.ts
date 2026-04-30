import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Pools } from '../db.js'
import { requireWriteToken } from '../auth.js'

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
      if (!host || !command) {
        return c.json({ error: 'host and command query params are required' }, 400)
      }
      const output = await c.req.text()
      await deps.pools.rw.query(
        `INSERT INTO hpc_metrics(host, command, output) VALUES ($1, $2, $3)`,
        [host, command, output]
      )
      return c.json({ ok: true })
    },
  )

  app.get('/api/hpc', async c => {
    const r = await deps.pools.ro.query(
      `SELECT host, command, output, collected_at
         FROM hpc_metrics_latest
         ORDER BY host, command`
    )
    const rows = r.rows.map(row => ({
      host: row.host as string,
      command: row.command as string,
      output: row.output as string,
      collected_at: (row.collected_at as Date).toISOString(),
    }))
    return c.json(rows)
  })
}
