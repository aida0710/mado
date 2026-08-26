import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { requirePermission, setSessionPrincipal } from './rbac.js'

describe('requirePermission', () => {
  it('permissionをserver-sideで検査する', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, {
        kind: 'user', sessionId: 's',
        user: {
          id: 'u', username: null, email: null, displayName: 'U', signatureName: 'U', status: 'active',
          roles: ['viewer'], permissions: ['storage:read'], mustChangePassword: false,
        },
      })
      await next()
    })
    app.get('/read', requirePermission('storage:read'), c => c.text('ok'))
    app.get('/admin', requirePermission('users:manage'), c => c.text('ok'))
    expect((await app.request('/read')).status).toBe(200)
    expect((await app.request('/admin')).status).toBe(403)
  })
})
