import type { Hono } from 'hono'
import type { Pools } from '../db.js'

// LAN-shared favorites: any LAN user can pin/unpin a bucket. The list is
// global per connection. PUT and DELETE are unauthenticated, mirroring the
// README PUT honor-system contract — defense lives at the LAN boundary.

export interface StorageFavoritesDeps {
  pools: Pools
}

export function mountStorageFavoritesRoutes(app: Hono, deps: StorageFavoritesDeps): void {
  app.get('/api/storage/:connId/favorites', async c => {
    const connId = c.req.param('connId')
    const r = await deps.pools.ro.query(
      `SELECT bucket FROM storage_favorite_buckets
         WHERE connection_id = $1
         ORDER BY bucket`,
      [connId],
    )
    return c.json(r.rows.map(row => row.bucket as string))
  })

  app.put('/api/storage/:connId/favorites/:bucket', async c => {
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

  app.delete('/api/storage/:connId/favorites/:bucket', async c => {
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
