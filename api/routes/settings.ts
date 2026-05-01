import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'

// Runtime feature flags. GET returns the current map, PUT toggles one.
// Honor-system: defense lives at the LAN boundary.

export interface SettingsDeps {
  pools: Pools
}

const PutBody = z.object({
  enabled: z.boolean(),
})

interface FlagRow {
  name: string
  enabled: boolean
}

export function mountSettingsRoutes(app: Hono, deps: SettingsDeps): void {
  app.get('/settings/flags', async c => {
    const r = await deps.pools.ro.query<FlagRow>(
      `SELECT name, enabled FROM feature_flags ORDER BY name`,
    )
    const map: Record<string, boolean> = {}
    for (const row of r.rows) map[row.name] = row.enabled
    return c.json(map)
  })

  app.put('/settings/flags/:name', async c => {
    const name = c.req.param('name')
    const parsed = PutBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const r = await deps.pools.rw.query(
      `UPDATE feature_flags
         SET enabled = $1, updated_at = now()
         WHERE name = $2`,
      [parsed.data.enabled, name],
    )
    if (r.rowCount === 0) return c.json({ error: 'unknown flag' }, 404)
    return c.json({ ok: true, name, enabled: parsed.data.enabled })
  })
}

// Throws 503 inside a Hono handler when the named flag is disabled.
// Returns true if enabled (or unknown — fail-open). Cached per-request via
// the Hono context to avoid redundant queries when multiple checks happen.
export async function isFlagEnabled(
  pools: Pools,
  name: string,
): Promise<boolean> {
  const r = await pools.ro.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags WHERE name = $1`,
    [name],
  )
  if (!r.rows[0]) return true
  return r.rows[0].enabled
}
