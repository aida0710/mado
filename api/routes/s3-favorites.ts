import type { Hono } from 'hono'
import type { Pools } from '../db.js'

// Lab-shared favorites: any LAN user can pin/unpin a bucket. The list is
// global. PUT and DELETE are unauthenticated, mirroring the README PUT
// honor-system contract — defense lives at the LAN boundary.

export interface S3FavoritesDeps {
  pools: Pools
}

export function mountS3FavoritesRoutes(app: Hono, deps: S3FavoritesDeps): void {
  app.get('/api/s3/favorites', async c => {
    const r = await deps.pools.ro.query(
      `SELECT bucket FROM s3_favorite_buckets ORDER BY bucket`,
    )
    return c.json(r.rows.map(row => row.bucket as string))
  })

  app.put('/api/s3/favorites/:bucket', async c => {
    const bucket = c.req.param('bucket')
    if (!bucket) return c.json({ error: 'bucket required' }, 400)
    await deps.pools.rw.query(
      `INSERT INTO s3_favorite_buckets(bucket) VALUES ($1)
         ON CONFLICT (bucket) DO NOTHING`,
      [bucket],
    )
    return c.json({ ok: true })
  })

  app.delete('/api/s3/favorites/:bucket', async c => {
    const bucket = c.req.param('bucket')
    if (!bucket) return c.json({ error: 'bucket required' }, 400)
    await deps.pools.rw.query(
      `DELETE FROM s3_favorite_buckets WHERE bucket = $1`,
      [bucket],
    )
    return c.json({ ok: true })
  })
}
