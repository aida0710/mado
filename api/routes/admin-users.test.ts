import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter } from '../lib/audit.js'
import { createAuthStore } from '../lib/auth-store.js'
import { setSessionPrincipal } from '../lib/rbac.js'
import { mountAdminUsersRoutes } from './admin-users.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const store = createAuthStore(pools.rw)
const audit = createAuditWriter(pools.rw)
let app: Hono
let adminId: string

beforeEach(async () => {
  await pools.rw.query('TRUNCATE audit_events, service_accounts, auth_users CASCADE')
  const admin = await store.createUser({ username: 'admin', email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] })
  adminId = admin.id
  app = new Hono()
  app.use('*', async (c, next) => {
    setSessionPrincipal(c, { kind: 'user', sessionId: 'test', user: admin })
    await next()
  })
  mountAdminUsersRoutes(app, { store, audit })
})
afterAll(() => closePools(pools))

describe('admin user routes', () => {
  it('最後のactive adminを無効化できない', async () => {
    const res = await app.request(`/users/${adminId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
    expect(res.status).toBe(409)
  })

  it('Local Userを作成し一時passwordを一度だけ返す', async () => {
    const create = await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'new-user', email: 'new@example.com', displayName: 'New', roles: ['viewer'] }),
    })
    expect(create.status).toBe(201)
    const user = (await create.json() as { user: { id: string } }).user
    const reset = await app.request(`/users/${user.id}/reset-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(reset.status).toBe(200)
    expect((await reset.json() as { temporaryPassword: string }).temporaryPassword.length).toBeGreaterThan(20)
    const credential = await store.getLocalCredential('new@example.com')
    expect(credential?.mustChangePassword).toBe(true)
  })
})
