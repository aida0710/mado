import type { Hono } from 'hono'
import type { Pools } from '../db.js'
import { requireWriteToken } from '../auth.js'

export interface HpcDeps {
  pools: Pools
  writeToken: string
}

export function mountHpcRoutes(app: Hono, deps: HpcDeps): void {
  app.post('/api/hpc/push', requireWriteToken(deps.writeToken), async c => {
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
  })
}
