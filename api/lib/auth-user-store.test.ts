import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createCredentialStore } from './auth-credential-store.js'
import { createAuditWriter } from './audit.js'
import { createSessionStore } from './auth-session-store.js'
import { createUserStore } from './auth-user-store.js'
import { hashPassword } from './password.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const users = createUserStore(pools.rw)
const credentials = createCredentialStore(pools.rw)
const sessions = createSessionStore(pools.rw, createAuditWriter(pools.rw))
const lifetime = { idleSeconds: 3600, absoluteSeconds: 7200 }

beforeEach(async () => {
  await pools.rw.query('TRUNCATE auth_oidc_logout_events, audit_events, service_accounts, auth_users CASCADE')
})
afterAll(() => closePools(pools))

describe('UserStore', () => {
  it('User と Role を作り、username と email を小文字にそろえる', async () => {
    const user = await users.createUser({
      username: 'Admin', email: 'Admin@Example.com', displayName: 'Admin', roles: ['admin'],
    })
    expect(user).toMatchObject({ username: 'admin', email: 'admin@example.com', signatureName: 'Admin' })
    expect(user.permissions).toContain('users:manage')
    expect(user.authMethods).toEqual([])
  })

  it('初期パスワードを渡すと、User と同じ transaction で Local の資格も作る', async () => {
    const user = await users.createUser({
      username: 'new-user', displayName: 'New', roles: ['viewer'],
      localPassword: { hash: await hashPassword('initial-password-123'), mustChange: true },
    })
    expect(user).toMatchObject({ authMethods: ['local'], mustChangePassword: true })
    expect((await credentials.findLocalCredentialByLogin('NEW-USER'))?.id).toBe(user.id)
  })

  it('無効にした User の session は、有効に戻しても復活しない', async () => {
    const user = await users.createUser({ email: 'u@example.com', displayName: 'U', roles: ['viewer'] })
    const session = await sessions.createSession({ userId: user.id, lifetime })
    await users.updateUser(user.id, { status: 'disabled' })
    expect(await sessions.authenticateSession(session.token, 3600)).toBeNull()
    await users.updateUser(user.id, { status: 'active' })
    expect(await sessions.authenticateSession(session.token, 3600)).toBeNull()
  })

  it('Role を変えたら session を失効させ、同じ Role の再保存では何も変えない', async () => {
    const user = await users.createUser({ email: 'u@example.com', displayName: 'U', roles: ['viewer'] })
    const session = await sessions.createSession({ userId: user.id, lifetime })
    expect((await users.replaceUserRoles(user.id, ['viewer'], user.id))?.changedFields).toEqual([])
    expect(await sessions.authenticateSession(session.token, 3600)).not.toBeNull()
    const changed = await users.replaceUserRoles(user.id, ['curator'], user.id)
    expect(changed).toMatchObject({ changedFields: ['roles'], user: { roles: ['curator'] } })
    expect(await sessions.authenticateSession(session.token, 3600)).toBeNull()
  })

  it('同時に 2 人を無効にしても、active な Admin を 0 人にしない', async () => {
    const a = await users.createUser({ email: 'a@example.com', displayName: 'A', roles: ['admin'] })
    const b = await users.createUser({ email: 'b@example.com', displayName: 'B', roles: ['admin'] })
    const results = await Promise.allSettled([
      users.updateUser(a.id, { status: 'disabled' }),
      users.updateUser(b.id, { status: 'disabled' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const active = await pools.rw.query(
      `SELECT count(DISTINCT u.id)::int AS count
         FROM auth_users u JOIN auth_user_roles ur ON ur.user_id = u.id
        WHERE u.status = 'active' AND u.deleted_at IS NULL AND ur.role_id = 'admin'`,
    )
    expect(active.rows[0].count).toBe(1)
  })

  it('削除した User は一覧から消え、session も失効する', async () => {
    await users.createUser({ email: 'admin@example.com', displayName: 'Admin', roles: ['admin'] })
    const user = await users.createUser({ email: 'u@example.com', displayName: 'U', roles: ['viewer'] })
    const session = await sessions.createSession({ userId: user.id, lifetime })
    expect(await users.deleteUser(user.id)).toBe(true)
    expect(await users.getUser(user.id)).toBeNull()
    expect(await sessions.authenticateSession(session.token, 3600)).toBeNull()
  })
})
