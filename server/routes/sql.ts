import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'
import { requireWriteToken } from '../auth.js'

const Body = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
})

export interface SqlDeps {
  pools: Pools
  writeToken: string
}

export function mountSqlRoutes(app: Hono, deps: SqlDeps): void {
  app.post('/sql/write', requireWriteToken(deps.writeToken), async c => {
    let parsed: z.infer<typeof Body>
    try {
      parsed = Body.parse(await c.req.json())
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    try {
      const r = await deps.pools.rw.query(parsed.sql, parsed.params ?? [])
      console.log(`[sql] ${parsed.sql.slice(0, 200)}`)
      if (r.command === 'SELECT' || r.rows.length > 0) {
        return c.json({ rows: r.rows })
      }
      return c.json({ rowCount: r.rowCount ?? 0 })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
}
