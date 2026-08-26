import { Hono } from 'hono'
import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { setSessionPrincipal } from '../lib/rbac.js'
import { mountAuditRoutes, ROUTINE_AUDIT_ACTIONS } from './audit.js'

const admin = {
  id: '00000000-0000-4000-8000-000000000001', username: 'admin', email: null,
  displayName: 'Admin', signatureName: 'Admin', status: 'active' as const,
  roles: ['admin'], permissions: ['audit:read'], mustChangePassword: false,
}

describe('audit routes', () => {
  it('通常一覧から閲覧・login・logoutのroutine eventを除外する', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 'session', user: admin })
      await next()
    })
    mountAuditRoutes(app, { pool: { query } as unknown as Pool })

    const response = await app.request('/audit-events?limit=30')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ events: [], nextBeforeId: null })

    const [sql, values] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('NOT (e.action = ANY($1::text[]))')
    expect(values).toEqual([[...ROUTINE_AUDIT_ACTIONS], 31])
  })
})
