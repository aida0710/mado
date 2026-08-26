import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuthStore } from './auth-store.js'
import { hashPassword } from './password.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const store = createAuthStore(pools.rw)

beforeEach(async () => {
  await pools.rw.query('TRUNCATE audit_events, service_accounts, auth_users CASCADE')
})
afterAll(() => closePools(pools))

describe('AuthStore', () => {
  it('user/role/local credential/sessionを作成しtokenはhashだけ保存する', async () => {
    const user = await store.createUser({
      username: 'Admin', email: 'Admin@Example.com', displayName: 'Admin', roles: ['admin'],
    })
    expect(user.username).toBe('admin')
    expect(user.email).toBe('admin@example.com')
    expect(user.permissions).toContain('users:manage')

    await store.setLocalPassword(user.id, await hashPassword('long-enough-password'), false)
    const credential = await store.getLocalCredential('ADMIN@example.com')
    expect(credential?.id).toBe(user.id)
    expect((await store.getLocalCredential('ADMIN'))?.id).toBe(user.id)

    const session = await store.createSession(user.id, { idleSeconds: 3600, absoluteSeconds: 7200 })
    const db = await pools.rw.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM auth_sessions WHERE id = $1', [session.id],
    )
    expect(db.rows[0].token_hash).toHaveLength(32)
    expect(db.rows[0].token_hash.toString()).not.toContain(session.token)

    const principal = await store.authenticateSession(session.token, 3600, 0)
    expect(principal?.user.id).toBe(user.id)
    expect(await store.revokeSession(session.token)).toBe(true)
    expect(await store.authenticateSession(session.token, 3600)).toBeNull()
  })

  it('disabled userのsessionを認証しない', async () => {
    const user = await store.createUser({ email: 'u@example.com', displayName: 'U', roles: ['viewer'] })
    const session = await store.createSession(user.id, { idleSeconds: 60, absoluteSeconds: 120 })
    await store.updateUser(user.id, { status: 'disabled' })
    expect(await store.authenticateSession(session.token, 60)).toBeNull()
  })

  it('最後のactive adminを判定する', async () => {
    const a = await store.createUser({ email: 'a@example.com', displayName: 'A', roles: ['admin'] })
    expect(await store.hasOtherActiveAdmin(a.id)).toBe(false)
    const b = await store.createUser({ email: 'b@example.com', displayName: 'B', roles: ['admin'] })
    expect(await store.hasOtherActiveAdmin(a.id)).toBe(true)
    await store.updateUser(b.id, { status: 'disabled' })
    expect(await store.hasOtherActiveAdmin(a.id)).toBe(false)
  })
})
