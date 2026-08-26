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

export const ROUTINE_AUDIT_ACTIONS = [
  'auth.local.login',
  'auth.oidc.login',
  'auth.logout',
  'audit.read',
] as const

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
    values.push([...ROUTINE_AUDIT_ACTIONS])
    where.push(`NOT (e.action = ANY($${values.length}::text[]))`)
    if (q.beforeId !== undefined) add('e.id < ?', q.beforeId)
    if (q.action !== undefined) add('e.action = ?', q.action)
    if (q.outcome !== undefined) add('e.outcome = ?', q.outcome)
    if (q.actorUserId !== undefined) add('e.actor_user_id = ?', q.actorUserId)
    if (q.actorServiceAccountId !== undefined) add('e.actor_service_account_id = ?', q.actorServiceAccountId)
    values.push(q.limit + 1)
    const r = await deps.pool.query(
      `SELECT e.id, e.occurred_at, e.request_id, e.actor_type, e.actor_user_id,
              e.actor_service_account_id, e.action, e.resource_type, e.resource_id,
              e.outcome, e.ip_address, e.user_agent, e.details,
              COALESCE(u.display_name, sa.name, e.actor_type) AS actor_label
         FROM audit_events e
         LEFT JOIN auth_users u ON u.id = e.actor_user_id
         LEFT JOIN service_accounts sa ON sa.id = e.actor_service_account_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.id DESC LIMIT $${values.length}`,
      values,
    )
    const hasMore = r.rows.length > q.limit
    const events = hasMore ? r.rows.slice(0, q.limit) : r.rows
    return c.json({ events, nextBeforeId: hasMore ? events.at(-1)?.id ?? null : null })
  })
}
