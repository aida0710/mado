import type { Hono } from 'hono'
import type { Pools } from '../db.js'

// LAN 共有のお気に入り: LAN の任意ユーザーがバケットをピン留め/解除できる。
// リストは接続ごとにグローバル。PUT/DELETE は認証なしで、
// README の PUT オナーシステム契約を踏襲する — 防御は LAN 境界に委ねる。

export interface StorageFavoritesDeps {
  pools: Pools
}

export function mountStorageFavoritesRoutes(app: Hono, deps: StorageFavoritesDeps): void {
  app.get('/storage/:connId/favorites', async c => {
    const connId = c.req.param('connId')
    const r = await deps.pools.ro.query(
      `SELECT bucket FROM storage_favorite_buckets
         WHERE connection_id = $1
         ORDER BY bucket`,
      [connId],
    )
    return c.json(r.rows.map(row => row.bucket as string))
  })

  app.put('/storage/:connId/favorites/:bucket', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.param('bucket')
    if (!bucket) return c.json({ error: 'bucket required' }, 400)
    await deps.pools.rw.query(
      `INSERT INTO storage_favorite_buckets(connection_id, bucket) VALUES ($1, $2)
         ON CONFLICT (connection_id, bucket) DO NOTHING`,
      [connId, bucket],
    )
    return c.json({ ok: true })
  })

  app.delete('/storage/:connId/favorites/:bucket', async c => {
    const connId = c.req.param('connId')
    const bucket = c.req.param('bucket')
    if (!bucket) return c.json({ error: 'bucket required' }, 400)
    await deps.pools.rw.query(
      `DELETE FROM storage_favorite_buckets
         WHERE connection_id = $1 AND bucket = $2`,
      [connId, bucket],
    )
    return c.json({ ok: true })
  })
}
