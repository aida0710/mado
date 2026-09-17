import type { Context, Hono } from 'hono'
import type { JobStore } from '../lib/jobs.js'
import { markAuditNoChange } from '../lib/audit-activity.js'

// ジョブの参照とキャンセル (spec: 2026-08-18-job-queue-design.md)。
// 投入は種別ごとのエンドポイントが行うので、ここには作らない。

export interface JobRoutesDeps {
  store: JobStore
  /** 認証有効時だけ渡す。job payload の connectionId も接続ACLで隠す。 */
  canAccessConnection?: (c: Context, connectionId: string) => Promise<boolean>
}

function connectionIdOf(job: { payload?: unknown }): string | null {
  if (!job.payload || typeof job.payload !== 'object') return null
  const connectionId = (job.payload as Record<string, unknown>).connectionId
  return typeof connectionId === 'string' ? connectionId : null
}

async function canReadJob(c: Context, job: { payload?: unknown }, deps: JobRoutesDeps): Promise<boolean> {
  const connectionId = connectionIdOf(job)
  return connectionId === null
    || deps.canAccessConnection === undefined
    || deps.canAccessConnection(c, connectionId)
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
    if (!job || !await canReadJob(c, job, deps)) return c.json({ error: 'not found' }, 404)
    return c.json(job)
  })

  app.get('/jobs/:id', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
    const job = await deps.store.get(id)
    if (!job || !await canReadJob(c, job, deps)) return c.json({ error: 'not found' }, 404)
    return c.json(job)
  })

  app.post('/jobs/:id/cancel', async c => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400)
    const job = await deps.store.get(id)
    if (!job || !await canReadJob(c, job, deps)) return c.json({ error: 'not found' }, 404)
    if (!await deps.store.cancel(id)) markAuditNoChange(c)
    return c.json({ ok: true })
  })
}
