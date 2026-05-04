import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'

// LAN オナーシステム: GET/PUT はどちらも認証なし。防御は LAN 境界に委ねる。
// `editor` は自己申告制で、README パターンを踏襲している。

export interface NotesDeps {
  pools: Pools
}

const PutBody = z.object({
  body: z.string(),
  editor: z.string().min(1),
})

interface NoteRow {
  body: string
  last_editor: string | null
  last_edited_at: Date
}

export function mountNotesRoutes(app: Hono, deps: NotesDeps): void {
  app.get('/notes/:slug', async c => {
    const slug = c.req.param('slug')
    const r = await deps.pools.ro.query<NoteRow>(
      `SELECT body, last_editor, last_edited_at FROM notes WHERE slug = $1`,
      [slug],
    )
    const row = r.rows[0]
    if (!row) return c.json({ exists: false })
    return c.json({
      exists: true,
      body: row.body,
      last_editor: row.last_editor,
      last_edited_at: row.last_edited_at.toISOString(),
    })
  })

  app.put('/notes/:slug', async c => {
    const slug = c.req.param('slug')
    if (slug.length < 1 || slug.length > 64) {
      return c.json({ error: 'invalid slug' }, 400)
    }
    const parsed = PutBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400)
    const { body, editor } = parsed.data
    const sizeBytes = Buffer.byteLength(body, 'utf-8')

    // notes (current state) と notes_history (append) を 1 transaction で
    // 同期させる。READMEs と同パターン。
    const client = await deps.pools.rw.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO notes_history (slug, body, size_bytes, editor)
         VALUES ($1, $2, $3, $4)`,
        [slug, body, sizeBytes, editor],
      )
      await client.query(
        `INSERT INTO notes (slug, body, last_editor, last_edited_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (slug) DO UPDATE
           SET body           = EXCLUDED.body,
               last_editor    = EXCLUDED.last_editor,
               last_edited_at = EXCLUDED.last_edited_at`,
        [slug, body, editor],
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    return c.json({ ok: true })
  })

  // Team note の編集履歴 (slug 単位、新しい順)。
  app.get('/notes/:slug/history', async c => {
    const slug = c.req.param('slug')
    const limitRaw = parseInt(c.req.query('limit') ?? '50', 10)
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 50, 200))
    const r = await deps.pools.ro.query<{
      id: string; editor: string; edited_at: Date; size_bytes: number
    }>(
      `SELECT id, editor, edited_at, size_bytes
         FROM notes_history
         WHERE slug = $1
         ORDER BY edited_at DESC, id DESC
         LIMIT $2`,
      [slug, limit],
    )
    return c.json({
      versions: r.rows.map(row => ({
        id: Number(row.id),
        editor: row.editor,
        edited_at: row.edited_at.toISOString(),
        size_bytes: row.size_bytes,
      })),
    })
  })

  // 特定版の本文。
  app.get('/notes/:slug/history/:id', async c => {
    const slug = c.req.param('slug')
    const id = c.req.param('id')
    if (!/^\d+$/.test(id)) return c.json({ error: 'id must be integer' }, 400)
    const r = await deps.pools.ro.query<{
      body: string; editor: string; edited_at: Date; size_bytes: number
    }>(
      `SELECT body, editor, edited_at, size_bytes
         FROM notes_history
         WHERE id = $1 AND slug = $2`,
      [id, slug],
    )
    if (!r.rows[0]) return c.json({ error: 'not found' }, 404)
    const row = r.rows[0]
    return c.json({
      id: Number(id),
      slug,
      body: row.body,
      editor: row.editor,
      edited_at: row.edited_at.toISOString(),
      size_bytes: row.size_bytes,
    })
  })
}
