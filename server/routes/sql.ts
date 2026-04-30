import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { Pools } from '../db.js'
import { requireWriteToken } from '../auth.js'

const Body = z.object({
  sql: z.string().min(1),
  params: z.array(z.unknown()).optional(),
})

const SQL_BODY_LIMIT = 1_000_000

export interface SqlDeps {
  pools: Pools
  writeToken: string
}

export function mountSqlRoutes(app: Hono, deps: SqlDeps): void {
  app.post(
    '/sql/write',
    requireWriteToken(deps.writeToken),
    bodyLimit({
      maxSize: SQL_BODY_LIMIT,
      onError: c => c.json({ error: 'request body too large' }, 413),
    }),
    async c => {
      let parsed: z.infer<typeof Body>
      try {
        parsed = Body.parse(await c.req.json())
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400)
      }
      // Audit trail: log full SQL + params BEFORE running, so failing
      // statements (PG syntax errors, permission errors) are also captured.
      // Multi-statement queries (`a; b`) make pg.query return an array, which
      // we don't unpack — the caller will get an unhelpful error and that's
      // documented behavior for an internal escape-hatch endpoint.
      console.log(JSON.stringify({
        ev: 'sql.write',
        sql: parsed.sql,
        params: parsed.params ?? [],
      }))
      try {
        const r = await deps.pools.rw.query(parsed.sql, parsed.params ?? [])
        if (r.command === 'SELECT' || r.rows.length > 0) {
          return c.json({ rows: r.rows })
        }
        return c.json({ rowCount: r.rowCount ?? 0 })
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400)
      }
    },
  )
}
