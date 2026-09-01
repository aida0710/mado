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

  it('ユーザーを編集し変更前後をauditへ残すがemailは変更させない', async () => {
    const user = await store.createUser({ username: 'before', email: 'fixed@example.com', displayName: 'Before', roles: ['viewer'] })
    const update = await app.request(`/users/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'after', displayName: 'After' }),
    })
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({ user: { username: 'after', email: 'fixed@example.com', displayName: 'After' } })
    const event = await pools.rw.query<{ details: { changes: Array<{ field: string; before: unknown; after: unknown }> } }>(
      `SELECT details FROM audit_events WHERE action = 'user.update' ORDER BY id DESC LIMIT 1`,
    )
    expect(event.rows[0].details.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'username', before: 'before', after: 'after' }),
    ]))
    expect((await app.request(`/users/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'changed@example.com' }),
    })).status).toBe(400)
  })

  it('同じユーザー情報・権限の再保存はauditへ残さない', async () => {
    const user = await store.createUser({ username: 'same', displayName: 'Same', roles: ['viewer'] })
    expect((await app.request(`/users/${user.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'same', displayName: 'Same', status: 'active' }),
    })).status).toBe(200)
    expect((await app.request(`/users/${user.id}/roles`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roles: ['viewer'] }),
    })).status).toBe(200)
    const events = await pools.rw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE resource_id = $1 AND action IN ('user.update', 'user.roles.update')`, [user.id],
    )
    expect(events.rows[0].count).toBe('0')
  })

  it('自分自身は削除できず、別ユーザーは削除してauditへ残す', async () => {
    expect((await app.request(`/users/${adminId}`, { method: 'DELETE' })).status).toBe(409)
    const user = await store.createUser({ username: 'delete-me', displayName: 'Delete Me', roles: ['viewer'] })
    expect((await app.request(`/users/${user.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await store.getUser(user.id)).toBeNull()
    const tombstone = await pools.rw.query<{ status: string; deleted_at: Date | null }>(
      `SELECT status, deleted_at FROM auth_users WHERE id = $1`, [user.id],
    )
    expect(tombstone.rows[0]).toMatchObject({ status: 'disabled' })
    expect(tombstone.rows[0].deleted_at).toBeInstanceOf(Date)
    const event = await pools.rw.query<{ action: string; details: { target: { username: string } } }>(
      `SELECT action, details FROM audit_events WHERE action = 'user.delete' ORDER BY id DESC LIMIT 1`,
    )
    expect(event.rows[0]).toMatchObject({ action: 'user.delete', details: { target: { username: 'delete-me' } } })
  })
})
