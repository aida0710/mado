import type { Hono } from 'hono'
import type { Pool } from 'pg'
import { z } from 'zod'
import { requirePermission } from '../lib/rbac.js'

export interface AuditRoutesDeps {
  pool: Pool
}

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeId: z.coerce.number().int().positive().optional(),
  action: z.string().min(1).max(128).optional(),
  outcome: z.enum(['success', 'denied', 'failure']).optional(),
  actorUserId: z.string().uuid().optional(),
  actorServiceAccountId: z.string().uuid().optional(),
})

export function mountAuditRoutes(app: Hono, deps: AuditRoutesDeps): void {
  app.use('/audit-events', requirePermission('audit:read'))
  app.get('/audit-events', async c => {
    const parsed = Query.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: 'invalid query' }, 400)
    const q = parsed.data
    const where: string[] = []
    const values: unknown[] = []
    const add = (sql: string, value: unknown) => {
      values.push(value)
      where.push(sql.replace('?', `$${values.length}`))
    }
    if (q.beforeId !== undefined) add('id < ?', q.beforeId)
    if (q.action !== undefined) add('action = ?', q.action)
    if (q.outcome !== undefined) add('outcome = ?', q.outcome)
    if (q.actorUserId !== undefined) add('actor_user_id = ?', q.actorUserId)
    if (q.actorServiceAccountId !== undefined) add('actor_service_account_id = ?', q.actorServiceAccountId)
    values.push(q.limit + 1)
    const r = await deps.pool.query(
      `SELECT id, occurred_at, request_id, actor_type, actor_user_id,
              actor_service_account_id, action, resource_type, resource_id,
              outcome, ip_address, user_agent, details
         FROM audit_events
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT $${values.length}`,
      values,
    )
    const hasMore = r.rows.length > q.limit
    const events = hasMore ? r.rows.slice(0, q.limit) : r.rows
    return c.json({ events, nextBeforeId: hasMore ? events.at(-1)?.id ?? null : null })
  })
}
