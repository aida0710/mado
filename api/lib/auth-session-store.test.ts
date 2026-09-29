import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createSessionStore } from './auth-session-store.js'
import { createUserStore } from './auth-user-store.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const users = createUserStore(pools.rw)
const sessions = createSessionStore(pools.rw)
const lifetime = { idleSeconds: 3600, absoluteSeconds: 7200 }

beforeEach(async () => {
  await pools.rw.query('TRUNCATE auth_oidc_logout_events, audit_events, service_accounts, auth_users CASCADE')
})
afterAll(() => closePools(pools))

describe('SessionStore', () => {
  it('session token は hash だけを保存し、失効させたら認証しない', async () => {
    const user = await users.createUser({ username: 'admin', displayName: 'Admin', roles: ['admin'] })
    const session = await sessions.createSession({ userId: user.id, lifetime })
    const db = await pools.rw.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM auth_sessions WHERE id = $1', [session.id],
    )
    expect(db.rows[0].token_hash).toHaveLength(32)
    expect(db.rows[0].token_hash.toString()).not.toContain(session.token)

    const principal = await sessions.authenticateSession(session.token, 3600, 0)
    expect(principal?.user.id).toBe(user.id)
    expect(await sessions.revokeSession(session.token)).toBe(true)
    expect(await sessions.authenticateSession(session.token, 3600)).toBeNull()
  })

  it('OIDC の sid・sub 単位で session を失効し、logout token の再送を拒否する', async () => {
    const user = await users.createUser({ displayName: 'SSO', roles: ['viewer'] })
    const a = await sessions.createSession({
      userId: user.id, lifetime, oidc: { issuer: 'https://auth.example', subject: 'sub-1', sid: 'sid-a' },
    })
    const b = await sessions.createSession({
      userId: user.id, lifetime, oidc: { issuer: 'https://auth.example', subject: 'sub-1', sid: 'sid-b' },
    })
    expect(await sessions.getSessionOidcContext(a.token)).toEqual({
      issuer: 'https://auth.example', subject: 'sub-1', sid: 'sid-a',
    })
    expect(await sessions.revokeOidcSessions({ issuer: 'https://auth.example', sid: 'sid-a' })).toBe(1)
    expect(await sessions.authenticateSession(a.token, 3600)).toBeNull()
    expect(await sessions.authenticateSession(b.token, 3600)).not.toBeNull()
    expect(await sessions.revokeOidcSessions({ issuer: 'https://auth.example', subject: 'sub-1' })).toBe(1)
    expect(await sessions.authenticateSession(b.token, 3600)).toBeNull()

    const expiry = new Date(Date.now() + 60_000)
    expect(await sessions.applyOidcBackchannelLogout({
      issuer: 'https://auth.example', subject: 'sub-1', jti: 'jti-1', expiresAt: expiry,
    })).toEqual({ accepted: true, revoked: 0 })
    expect(await sessions.applyOidcBackchannelLogout({
      issuer: 'https://auth.example', subject: 'sub-1', jti: 'jti-1', expiresAt: expiry,
    })).toEqual({ accepted: false, revoked: 0 })
  })
})
