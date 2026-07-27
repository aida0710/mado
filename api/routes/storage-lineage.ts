import type { Hono } from 'hono'
import { z } from 'zod'
import type { Pools } from '../db.js'

// LAN 共有: README / favorites と同じオナーシステム。認証なし、防御は LAN 境界に委ねる。

export interface StorageLineageDeps {
  pools: Pools
}

const NodeRef = z.object({
  bucket: z.string().min(1),
  path: z.string(),
})

const PostBody = z.object({
  parent: NodeRef,
  child: NodeRef,
  editor: z.string().min(1),
})

const LINK_COLUMNS = `
  id,
  parent_bucket AS "parentBucket",
  parent_path   AS "parentPath",
  child_bucket  AS "childBucket",
  child_path    AS "childPath",
  created_by    AS "createdBy",
  created_at    AS "createdAt"
`

export function mountStorageLineageRoutes(app: Hono, deps: StorageLineageDeps): void {
  app.get('/storage/:connId/lineage-links', async c => {
    const connId = c.req.param('connId')
    const r = await deps.pools.ro.query(
      `SELECT ${LINK_COLUMNS} FROM storage_lineage_links WHERE connection_id = $1 ORDER BY id`,
      [connId],
    )
    return c.json(r.rows.map(row => ({ ...row, id: Number(row.id) })))
  })

  app.post('/storage/:connId/lineage-links', async c => {
    const connId = c.req.param('connId')
    const parsed = PostBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid body' }, 400)
    const { parent, child, editor } = parsed.data
    if (parent.bucket === child.bucket && parent.path === child.path) {
      return c.json({ error: 'parent and child must differ' }, 400)
    }
    // ON CONFLICT DO UPDATE で重複登録を無害化しつつ、新規/既存いずれでも id を
    // 返す (フロントが「解除」ボタンへ即座に紐づける id を必要とするため)。
    // DO UPDATE は (DO NOTHING と違い) 衝突時も対象行をロックして必ず1行返す
    // ことが Postgres で保証されているため、DO NOTHING + フォールバック SELECT
    // 方式で起きていた「両方 0 行になる」並行 POST 時のレースが発生しない。
    // created_by は EXCLUDED を使わず既存値へ書き戻す no-op にしているため、
    // 重複 POST があっても最初の作成者名はそのまま維持される。
    const r = await deps.pools.rw.query(
      `INSERT INTO storage_lineage_links
         (connection_id, parent_bucket, parent_path, child_bucket, child_path, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (connection_id, parent_bucket, parent_path, child_bucket, child_path)
       DO UPDATE SET created_by = storage_lineage_links.created_by
       RETURNING id`,
      [connId, parent.bucket, parent.path, child.bucket, child.path, editor],
    )
    return c.json({ ok: true, id: Number(r.rows[0].id) })
  })

  app.delete('/storage/:connId/lineage-links/:id', async c => {
    const connId = c.req.param('connId')
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
    await deps.pools.rw.query(
      `DELETE FROM storage_lineage_links WHERE connection_id = $1 AND id = $2`,
      [connId, id],
    )
    return c.json({ ok: true })
  })
}
