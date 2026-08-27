import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuthStore } from './auth-store.js'
import { hashPassword } from './password.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const store = createAuthStore(pools.rw)

beforeEach(async () => {
  await pools.rw.query('TRUNCATE auth_oidc_logout_events, audit_events, service_accounts, auth_users CASCADE')
})
afterAll(() => closePools(pools))

describe('AuthStore', () => {
  it('user/role/local credential/sessionを作成しtokenはhashだけ保存する', async () => {
    const user = await store.createUser({
      username: 'Admin', email: 'Admin@Example.com', displayName: 'Admin', roles: ['admin'],
    })
    expect(user.username).toBe('admin')
    expect(user.email).toBe('admin@example.com')
    expect(user.signatureName).toBe('Admin')
    expect(user.permissions).toContain('users:manage')

    expect((await store.updateSignatureName(user.id, '署名'))?.signatureName).toBe('署名')

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

  it('並行操作でもactive adminを0人にしない', async () => {
    const a = await store.createUser({ email: 'a@example.com', displayName: 'A', roles: ['admin'] })
    const b = await store.createUser({ email: 'b@example.com', displayName: 'B', roles: ['admin'] })
    const results = await Promise.allSettled([
      store.updateUser(a.id, { status: 'disabled' }),
      store.updateUser(b.id, { status: 'disabled' }),
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

  it('検証済みemailだけを既存Local Userへ連携し、OIDC groupのroleを同期する', async () => {
    const local = await store.createUser({
      username: 'local', email: 'same@example.com', displayName: 'Local', roles: ['viewer'],
    })
    await store.setLocalPassword(local.id, await hashPassword('long-enough-password'), false)
    const linked = await store.provisionOidcUser({
      issuer: 'https://auth.example/application/o/mado', subject: 'verified-subject',
      email: 'same@example.com', emailVerified: true, username: 'from-sso', displayName: 'SSO Name',
      groups: ['mado-admins'], autoLinkVerifiedEmail: true, defaultRole: 'viewer', managedRoles: ['admin'],
    })
    expect(linked).toMatchObject({ created: false, linkedExisting: true })
    expect(linked.user.id).toBe(local.id)
    expect(linked.user.authMethods).toEqual(['local', 'sso'])
    expect(linked.user.roles).toEqual(['admin'])
    expect(linked.user.username).toBe('local')

    const unverified = await store.provisionOidcUser({
      issuer: 'https://auth.example/application/o/mado', subject: 'unverified-subject',
      email: 'same@example.com', emailVerified: false, username: 'new-sso', displayName: 'Other',
      groups: [], autoLinkVerifiedEmail: true, defaultRole: 'viewer',
    })
    expect(unverified).toMatchObject({ created: true, linkedExisting: false })
    expect(unverified.user.id).not.toBe(local.id)
    expect(unverified.user.email).toBeNull()
  })

  it('特権Local Userへのemail自動連携を拒否する', async () => {
    await store.createUser({
      username: 'admin', email: 'admin@example.com', displayName: 'Admin', roles: ['admin'],
    })
    await expect(store.provisionOidcUser({
      issuer: 'https://auth.example', subject: 'attacker-subject',
      email: 'admin@example.com', emailVerified: true, username: 'attacker', displayName: 'Attacker',
      groups: ['mado-users'], autoLinkVerifiedEmail: true, defaultRole: 'viewer',
    })).rejects.toThrow(/explicit oidc linking/)
  })

  it('OIDC sid/sub単位でsessionを失効しlogout tokenのreplayを拒否する', async () => {
    const user = await store.createUser({ displayName: 'SSO', roles: ['viewer'] })
    const a = await store.createSession(user.id, { idleSeconds: 3600, absoluteSeconds: 7200 }, {}, {
      issuer: 'https://auth.example', subject: 'sub-1', sid: 'sid-a',
    })
    const b = await store.createSession(user.id, { idleSeconds: 3600, absoluteSeconds: 7200 }, {}, {
      issuer: 'https://auth.example', subject: 'sub-1', sid: 'sid-b',
    })
    expect(await store.getSessionOidcContext(a.token)).toEqual({
      issuer: 'https://auth.example', subject: 'sub-1', sid: 'sid-a',
    })
    expect(await store.revokeOidcSessions({ issuer: 'https://auth.example', sid: 'sid-a' })).toBe(1)
    expect(await store.authenticateSession(a.token, 3600)).toBeNull()
    expect(await store.authenticateSession(b.token, 3600)).not.toBeNull()
    expect(await store.revokeOidcSessions({ issuer: 'https://auth.example', subject: 'sub-1' })).toBe(1)
    expect(await store.authenticateSession(b.token, 3600)).toBeNull()

    const expiry = new Date(Date.now() + 60_000)
    expect(await store.applyOidcBackchannelLogout({
      issuer: 'https://auth.example', subject: 'sub-1', jti: 'jti-1', expiresAt: expiry,
    })).toEqual({ accepted: true, revoked: 0 })
    expect(await store.applyOidcBackchannelLogout({
      issuer: 'https://auth.example', subject: 'sub-1', jti: 'jti-1', expiresAt: expiry,
    })).toEqual({ accepted: false, revoked: 0 })
  })
})
