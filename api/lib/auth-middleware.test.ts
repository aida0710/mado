import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AuthUser } from './auth-types.js'
import { requirePasswordChangeComplete } from './auth-middleware.js'
import { setSessionPrincipal } from './rbac.js'

const user = (mustChangePassword: boolean): AuthUser => ({
  id: '00000000-0000-4000-8000-000000000001', username: 'admin', email: null,
  displayName: 'Admin', signatureName: 'Admin', status: 'active', roles: ['admin'],
  permissions: ['settings:manage'], mustChangePassword, authMethods: ['local'],
})

describe('requirePasswordChangeComplete', () => {
  it('変更必須sessionの通常APIを403にする', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 'session', user: user(true) })
      await next()
    })
    app.use('*', requirePasswordChangeComplete())
    app.get('/settings', c => c.json({ ok: true }))
    const response = await app.request('/settings')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'password change required' })
  })

  it('変更済みsessionを通す', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => {
      setSessionPrincipal(c, { kind: 'user', sessionId: 'session', user: user(false) })
      await next()
    })
    app.use('*', requirePasswordChangeComplete())
    app.get('/settings', c => c.json({ ok: true }))
    expect((await app.request('/settings')).status).toBe(200)
  })
})
