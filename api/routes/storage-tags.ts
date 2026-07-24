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

const TargetKindSchema = z.enum(['bucket', 'prefix', 'file'])

const AssignmentBody = z.object({
  bucket: z.string().min(1),
  kind: TargetKindSchema,
  path: z.string(),
  tagId: z.string().min(1),
})

// kind='bucket' は対象がバケット自体 1 つなので path を '' に固定する。
// 呼び出し側が何を渡しても同じキーに正規化することで、
// バケット自体のタグが複数の path に分裂しないようにする。
function normalizePath(kind: z.infer<typeof TargetKindSchema>, path: string): string {
  return kind === 'bucket' ? '' : path
}

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

  app.get('/storage/:connId/tags', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.query('bucket')
    if (!bucket) return c.json({ error: 'bucket is required' }, 400)
    const kindRaw = c.req.query('kind')
    const kindParsed = TargetKindSchema.safeParse(kindRaw)
    if (!kindParsed.success) return c.json({ error: 'kind must be bucket|prefix|file' }, 400)
    const kind = kindParsed.data
    const paths = c.req.queries('paths') ?? []
    if (paths.length === 0) return c.json({})

    const r = await deps.pools.ro.query<{ target_path: string; tag_id: string }>(
      `SELECT target_path, tag_id FROM storage_tag_assignments
         WHERE connection_id = $1 AND bucket = $2 AND target_kind = $3
           AND target_path = ANY($4::text[])`,
      [connId, bucket, kind, paths.map(p => normalizePath(kind, p))],
    )
    const out: Record<string, string[]> = {}
    for (const row of r.rows) {
      (out[row.target_path] ??= []).push(row.tag_id)
    }
    return c.json(out)
  })

  app.put('/storage/:connId/tags', async c => {
    const connId = c.req.param('connId')
    const parsed = AssignmentBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { bucket, kind, path, tagId } = parsed.data
    await deps.pools.rw.query(
      `INSERT INTO storage_tag_assignments (tag_id, connection_id, bucket, target_kind, target_path)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (connection_id, bucket, target_kind, target_path, tag_id) DO NOTHING`,
      [tagId, connId, bucket, kind, normalizePath(kind, path)],
    )
    return c.json({ ok: true })
  })

  app.delete('/storage/:connId/tags', async c => {
    const connId = c.req.param('connId')
    const parsed = AssignmentBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { bucket, kind, path, tagId } = parsed.data
    await deps.pools.rw.query(
      `DELETE FROM storage_tag_assignments
         WHERE tag_id = $1 AND connection_id = $2 AND bucket = $3
           AND target_kind = $4 AND target_path = $5`,
      [tagId, connId, bucket, kind, normalizePath(kind, path)],
    )
    return c.json({ ok: true })
  })
}
