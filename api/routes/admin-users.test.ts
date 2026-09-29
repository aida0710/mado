import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter } from '../lib/audit.js'
import { createUserStore } from '../lib/auth-user-store.js'
import { createCredentialStore } from '../lib/auth-credential-store.js'
import { setSessionPrincipal } from '../lib/rbac.js'
import { mountAdminUsersRoutes } from './admin-users.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const users = createUserStore(pools.rw)
const credentials = createCredentialStore(pools.rw)
const audit = createAuditWriter(pools.rw)
let app: Hono
let adminId: string

beforeEach(async () => {
  await pools.rw.query('TRUNCATE audit_events, service_accounts, auth_users CASCADE')
  const admin = await users.createUser({ username: 'admin', email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] })
  adminId = admin.id
  app = new Hono()
  app.use('*', async (c, next) => {
    setSessionPrincipal(c, { kind: 'user', sessionId: 'test', user: admin })
    await next()
  })
  mountAdminUsersRoutes(app, {
    users,
    credentials,
    audit,
    ssoRoleMapping: { 'mado-users': 'viewer', 'mado-admins': 'admin' },
  })
})
afterAll(() => closePools(pools))

describe('ユーザー管理 route', () => {
  it('User一覧と実際のSSO Role mappingを返す', async () => {
    const res = await app.request('/users')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ssoRoleMapping: { 'mado-users': 'viewer', 'mado-admins': 'admin' },
    })
  })

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
    const credential = await credentials.findLocalCredentialByLogin('new@example.com')
    expect(credential?.mustChangePassword).toBe(true)
  })

  it('ユーザーを編集し変更前後をauditへ残すがemailは変更させない', async () => {
    const user = await users.createUser({ username: 'before', email: 'fixed@example.com', displayName: 'Before', roles: ['viewer'] })
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
    const user = await users.createUser({ username: 'same', displayName: 'Same', roles: ['viewer'] })
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
    const user = await users.createUser({ username: 'delete-me', displayName: 'Delete Me', roles: ['viewer'] })
    expect((await app.request(`/users/${user.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await users.getUser(user.id)).toBeNull()
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

  it('初期パスワードが 1024 byte を超えると 400 にし、User も作らない', async () => {
    // 日本語 1 文字は 3 byte。文字数では 1024 以下でも byte では超える。
    const tooLong = 'あ'.repeat(400)
    const res = await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'long-password', displayName: 'Long', roles: ['viewer'], password: tooLong }),
    })
    expect(res.status).toBe(400)
    expect((await users.listUsers()).map(user => user.username)).not.toContain('long-password')
  })

  it('初期パスワード付きで作った User は、次回の変更が必須になる', async () => {
    const res = await app.request('/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'with-password', displayName: 'With', roles: ['viewer'], password: 'initial-password-123' }),
    })
    expect(res.status).toBe(201)
    expect((await credentials.findLocalCredentialByLogin('with-password'))?.mustChangePassword).toBe(true)
  })
})
