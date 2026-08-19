import type { Hono } from 'hono'
import type { JobStore } from '../lib/jobs.js'

// ジョブの参照とキャンセル (spec: 2026-08-18-job-queue-design.md)。
// 投入は種別ごとのエンドポイントが行うので、ここには作らない。

export interface JobRoutesDeps {
  store: JobStore
}

export function mountJobRoutes(app: Hono, deps: JobRoutesDeps): void {
  // /jobs/latest は /jobs/:id より先に登録すること。
  // Hono は登録順に照合するので、逆にすると latest が :id に食われる。
  app.get('/jobs/latest', async c => {
    const kind = c.req.query('kind')
    const dedupKey = c.req.query('dedupKey')
    if (!kind || !dedupKey) return c.json({ error: 'kind and dedupKey are required' }, 400)
    // 実行中があればそれを返す。リロードした UI が走査中のジョブへ
    // 再接続できるようにするため (完了済みだけだと見失う)。
    const job = await deps.store.activeOrLatest(kind, dedupKey)
    return job ? c.json(job) : c.json({ error: 'not found' }, 404)
  })

  app.get('/jobs/:id', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
    const job = await deps.store.get(id)
    return job ? c.json(job) : c.json({ error: 'not found' }, 404)
  })

  app.post('/jobs/:id/cancel', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
    await deps.store.cancel(id)
    return c.json({ ok: true })
  })
}
