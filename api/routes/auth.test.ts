import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter } from '../lib/audit.js'
import { createAuthStore } from '../lib/auth-store.js'
import { hashPassword } from '../lib/password.js'
import { mountAuthRoutes } from './auth.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const store = createAuthStore(pools.rw)
const audit = createAuditWriter(pools.rw)
const app = new Hono()
mountAuthRoutes(app, {
  store,
  audit,
  config: {
    localEnabled: true,
    session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false, cookieName: 'mado_session' },
  },
})

beforeEach(async () => {
  await pools.rw.query('TRUNCATE audit_events, service_accounts, auth_users CASCADE')
  const user = await store.createUser({ username: 'local-user', email: 'user@example.com', displayName: 'User', roles: ['viewer'] })
  await store.setLocalPassword(user.id, await hashPassword('correct-password-123'), false)
})
afterAll(() => closePools(pools))

describe('auth routes', () => {
  it('local loginでHttpOnly sessionを発行し/meで認証する', async () => {
    const login = await app.request('/local/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'local-user', password: 'correct-password-123' }),
    })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')
    expect(cookie).toContain('mado_session=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')

    const me = await app.request('/me', { headers: { Cookie: cookie!.split(';')[0] } })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ user: { username: 'local-user', email: 'user@example.com', roles: ['viewer'] } })
  })

  it('password誤りはgeneric 401でauditし、sessionを発行しない', async () => {
    const res = await app.request('/local/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'local-user', password: 'wrong' }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid identifier or password' })
    expect(res.headers.get('set-cookie')).toBeNull()
    const events = await pools.rw.query(
      `SELECT outcome FROM audit_events WHERE action = 'auth.local.login'`,
    )
    expect(events.rows).toEqual([{ outcome: 'denied' }])
  })

  it('cookie無しの/meを401にする', async () => {
    expect((await app.request('/me')).status).toBe(401)
  })
})
