import type { Hono } from 'hono'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import type { Pools } from '../db.js'

// README/favorites と同じ「オナーシステム」— 認証なし。
// 防御は LAN 境界 (requireSafeOrigin ミドルウェア) に委ねる。

export interface StorageTagsDeps {
  pools: Pools
}

const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #RRGGBB')

const CreateTagBody = z.object({
  name: z.string().min(1).max(32),
  color: ColorSchema,
})

const UpdateTagBody = z.object({
  name: z.string().min(1).max(32).optional(),
  color: ColorSchema.optional(),
})

interface TagRow {
  id: string
  name: string
  color: string
}

export function mountStorageTagsRoutes(app: Hono, deps: StorageTagsDeps): void {
  app.get('/tags', async c => {
    const r = await deps.pools.ro.query<TagRow>(
      `SELECT id, name, color FROM storage_tags ORDER BY name`,
    )
    return c.json(r.rows)
  })

  app.post('/tags', async c => {
    const parsed = CreateTagBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { name, color } = parsed.data
    const id = nanoid(10)
    try {
      const r = await deps.pools.rw.query<TagRow>(
        `INSERT INTO storage_tags (id, name, color) VALUES ($1, $2, $3)
         RETURNING id, name, color`,
        [id, name, color],
      )
      return c.json(r.rows[0])
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('storage_tags_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    }
  })

  app.put('/tags/:id', async c => {
    const id = c.req.param('id')
    const parsed = UpdateTagBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const u = parsed.data

    const sets: string[] = []
    const values: unknown[] = []
    let i = 1
    if (u.name !== undefined)  { sets.push(`name = $${i++}`);  values.push(u.name) }
    if (u.color !== undefined) { sets.push(`color = $${i++}`); values.push(u.color) }
    if (sets.length === 0) {
      const r = await deps.pools.ro.query<TagRow>(
        `SELECT id, name, color FROM storage_tags WHERE id = $1`, [id],
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      return c.json(r.rows[0])
    }
    values.push(id)
    try {
      const r = await deps.pools.rw.query<TagRow>(
        `UPDATE storage_tags SET ${sets.join(', ')} WHERE id = $${i}
         RETURNING id, name, color`,
        values,
      )
      if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
      return c.json(r.rows[0])
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('storage_tags_name_key') || msg.includes('duplicate key')) {
        return c.json({ error: 'name already exists' }, 409)
      }
      throw e
    }
  })

  app.delete('/tags/:id', async c => {
    const id = c.req.param('id')
    const r = await deps.pools.rw.query(`DELETE FROM storage_tags WHERE id = $1`, [id])
    if (r.rowCount === 0) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })
}
