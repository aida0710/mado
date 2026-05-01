import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'

// LAN honor-system: GET and PUT are both unauthenticated. Defense lives at the
// LAN boundary; `editor` is self-reported, mirroring the README pattern.

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
    await deps.pools.rw.query(
      `INSERT INTO notes (slug, body, last_editor, last_edited_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (slug) DO UPDATE
         SET body           = EXCLUDED.body,
             last_editor    = EXCLUDED.last_editor,
             last_edited_at = EXCLUDED.last_edited_at`,
      [slug, body, editor],
    )
    return c.json({ ok: true })
  })
}
