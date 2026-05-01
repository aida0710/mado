import type { Hono } from 'hono'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import type { Pools } from '../db.js'
import type { CryptoModule } from '../crypto.js'

// All endpoints are unauthenticated, mirroring the README/favorites honor-system
// contract — defense lives at the LAN boundary, not in the handler. The
// credentials themselves are encrypted at rest with ENCRYPTION_KEY, so an
// unauthorized create/update doesn't leak existing keys.
export interface ConnectionsDeps {
  pools: Pools
  crypto: CryptoModule
  invalidate: (id: string) => void
}

const CreateBody = z.object({
  name: z.string().min(1).max(64),
  endpoint: z.string().url().max(512),
  region: z.string().min(1).max(64).default('auto'),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(256),
  forcePathStyle: z.boolean().default(true),
})

const UpdateBody = z.object({
  name: z.string().min(1).max(64).optional(),
  endpoint: z.string().url().max(512).optional(),
  region: z.string().min(1).max(64).optional(),
  accessKeyId: z.string().min(1).max(256).optional(),
  secretAccessKey: z.string().min(1).max(256).optional(),
  forcePathStyle: z.boolean().optional(),
})

interface ConnectionRow {
  id: string
  name: string
  endpoint: string
  region: string
  access_key_id_masked: string
  force_path_style: boolean
  created_at: Date
  updated_at: Date
}

function toMasked(row: ConnectionRow) {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    region: row.region,
    accessKeyIdMasked: row.access_key_id_masked,
    forcePathStyle: row.force_path_style,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function mountConnectionsRoutes(app: Hono, deps: ConnectionsDeps): void {
  app.get('/api/connections', async c => {
    const r = await deps.pools.ro.query<ConnectionRow>(
      `SELECT id, name, endpoint, region, access_key_id_masked, force_path_style, created_at, updated_at
         FROM storage_connections ORDER BY name`,
    )
    return c.json(r.rows.map(toMasked))
  })

  app.post('/api/connections', async c => {
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { name, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle } = parsed.data
    const id = nanoid(10)
    try {
      const r = await deps.pools.rw.query<ConnectionRow>(
        `INSERT INTO storage_connections
           (id, name, endpoint, region, access_key_id_enc, secret_access_key_enc, access_key_id_masked, force_path_style)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, name, endpoint, region, access_key_id_masked, force_path_style, created_at, updated_at`,
        [
          id, name, endpoint, region,
          deps.crypto.encrypt(accessKeyId),
          deps.crypto.encrypt(secretAccessKey),
          deps.crypto.mask(accessKeyId),
          forcePathStyle,
        ],
      )
      return c.json(toMasked(r.rows[0]))
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('storage_connections_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    }
  })

  app.put('/api/connections/:id', async c => {
    const id = c.req.param('id')
    const parsed = UpdateBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const u = parsed.data

    // Build dynamic SET clause for the fields that were provided.
    const sets: string[] = []
    const values: unknown[] = []
    let i = 1
    if (u.name !== undefined)            { sets.push(`name = $${i++}`);                  values.push(u.name) }
    if (u.endpoint !== undefined)        { sets.push(`endpoint = $${i++}`);              values.push(u.endpoint) }
    if (u.region !== undefined)          { sets.push(`region = $${i++}`);                values.push(u.region) }
    if (u.forcePathStyle !== undefined)  { sets.push(`force_path_style = $${i++}`);      values.push(u.forcePathStyle) }
    if (u.accessKeyId !== undefined) {
      sets.push(`access_key_id_enc = $${i++}`);    values.push(deps.crypto.encrypt(u.accessKeyId))
      sets.push(`access_key_id_masked = $${i++}`); values.push(deps.crypto.mask(u.accessKeyId))
    }
    if (u.secretAccessKey !== undefined) {
      sets.push(`secret_access_key_enc = $${i++}`); values.push(deps.crypto.encrypt(u.secretAccessKey))
    }
    if (sets.length === 0) {
      // Nothing to update — just return current row.
      const r = await deps.pools.ro.query<ConnectionRow>(
        `SELECT id, name, endpoint, region, access_key_id_masked, force_path_style, created_at, updated_at
           FROM storage_connections WHERE id = $1`,
        [id],
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      return c.json(toMasked(r.rows[0]))
    }
    values.push(id)
    try {
      const r = await deps.pools.rw.query<ConnectionRow>(
        `UPDATE storage_connections SET ${sets.join(', ')} WHERE id = $${i}
         RETURNING id, name, endpoint, region, access_key_id_masked, force_path_style, created_at, updated_at`,
        values,
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      deps.invalidate(id)
      return c.json(toMasked(r.rows[0]))
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('storage_connections_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    }
  })

  app.delete('/api/connections/:id', async c => {
    const id = c.req.param('id')
    const r = await deps.pools.rw.query(
      `DELETE FROM storage_connections WHERE id = $1`, [id],
    )
    if (r.rowCount === 0) return c.json({ error: 'not found' }, 404)
    deps.invalidate(id)
    return c.json({ ok: true })
  })
}
