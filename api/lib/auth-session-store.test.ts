import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter } from './audit.js'
import { createSessionStore } from './auth-session-store.js'
import { createUserStore } from './auth-user-store.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const users = createUserStore(pools.rw)
const sessions = createSessionStore(pools.rw, createAuditWriter(pools.rw))
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

  it('IdP からの logout で失効させたら、失効と同じ transaction で監査に残す', async () => {
    const user = await users.createUser({ displayName: 'SSO', roles: ['viewer'] })
    await sessions.createSession({
      userId: user.id, lifetime, oidc: { issuer: 'https://auth.example', subject: 'sub-1', sid: 'sid-a' },
    })
    await sessions.createSession({
      userId: user.id, lifetime, oidc: { issuer: 'https://auth.example', subject: 'sub-1', sid: 'sid-b' },
    })
    await sessions.revokeOidcSessions({ issuer: 'https://auth.example', sid: 'sid-a' }, { ipAddress: '10.0.0.1' })
    await sessions.applyOidcBackchannelLogout({
      issuer: 'https://auth.example', subject: 'sub-1', jti: 'jti-2', expiresAt: new Date(Date.now() + 60_000),
    })
    const events = await pools.rw.query<{ resource_type: string; details: { channel: string; revoked: number } }>(
      `SELECT resource_type, details FROM audit_events WHERE action = 'auth.oidc.session_revoke' ORDER BY id`,
    )
    expect(events.rows).toEqual([
      expect.objectContaining({ resource_type: 'oidc_session', details: { channel: 'front', revoked: 1 } }),
      expect.objectContaining({ resource_type: 'oidc_identity', details: { channel: 'back', revoked: 1 } }),
    ])
  })

  it('失効させた session が無ければ、監査は残さない', async () => {
    await sessions.revokeOidcSessions({ issuer: 'https://auth.example', sid: 'unknown-sid' })
    const events = await pools.rw.query(`SELECT id FROM audit_events WHERE action = 'auth.oidc.session_revoke'`)
    expect(events.rows).toEqual([])
  })
})
