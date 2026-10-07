import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPools, closePools } from '../db.js'
import { createCrypto } from '../crypto.js'
import { createAuditWriter } from './audit.js'
import { createUserStore } from './auth-user-store.js'
import { createSessionStore } from './auth-session-store.js'
import { createOidcSessionVerifier, OidcSessionCheckUnavailableError } from './auth-oidc-session.js'
import type { OidcProvider, OidcSessionTokens } from './auth-oidc.js'

const RW = process.env.DATABASE_URL_RW_TEST ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const crypto = createCrypto('a'.repeat(64))
const audit = createAuditWriter(pools.rw)
const users = createUserStore(pools.rw)
const issuer = 'https://auth.example'
const checkSession = vi.fn(async (tokens: OidcSessionTokens) => ({ groups: ['mado-users'], tokens }))
const provider: OidcProvider = {
  id: 'test', label: 'Test', issuer, checkSession,
  matchesIssuer: value => value === issuer,
  start: async () => new URL('https://auth.example/start'),
  finish: async () => { throw new Error('unused') },
  logoutUrl: async () => new URL('https://auth.example/logout'),
  verifyBackchannelLogoutToken: async () => { throw new Error('unused') },
  deleteExpiredAttempts: async () => 0,
}
const sessions = createSessionStore(pools.rw, audit, createOidcSessionVerifier({
  pool: pools.rw, crypto, provider, audit,
  policy: { allowedGroups: ['mado-users', 'mado-admins'], roleMapping: { 'mado-admins': 'admin', 'mado-users': 'viewer' }, defaultRole: 'viewer' },
}))
const lifetime = { idleSeconds: 3600, absoluteSeconds: 7200 }

beforeEach(async () => {
  checkSession.mockReset().mockImplementation(async tokens => ({ groups: ['mado-users'], tokens }))
  await pools.rw.query('TRUNCATE auth_oidc_logout_events, audit_events, service_accounts, auth_users CASCADE')
})
afterAll(() => closePools(pools))

async function fixture(roles = ['viewer']) {
  const user = await users.createUser({ displayName: 'SSO', roles })
  const session = await sessions.createSession({ userId: user.id, lifetime, oidc: {
    issuer, subject: 'subject', sid: 'sid', tokens: {
      accessTokenEnc: crypto.encrypt('idp-access-secret'), refreshTokenEnc: crypto.encrypt('idp-refresh-secret'),
      expiresAt: new Date(Date.now() + 300_000),
    },
  } })
  const makeDue = () => pools.rw.query("UPDATE auth_sessions SET oidc_checked_at = now() - interval '61 seconds' WHERE id = $1", [session.id])
  return { user, session, makeDue, authenticate: () => sessions.authenticateSession(session.token, lifetime.idleSeconds, 0) }
}

describe('OIDC sessionの定期確認', () => {
  it('1分以内はIdPを呼ばず、期限が来た同時要求は一度だけ現在のgroupを確認する', async () => {
    const person = await fixture()
    expect(await person.authenticate()).not.toBeNull()
    expect(checkSession).not.toHaveBeenCalled()
    await person.makeDue()
    const principals = await Promise.all(Array.from({ length: 3 }, () => person.authenticate()))
    expect(principals.every(principal => principal?.user.id === person.user.id)).toBe(true)
    expect(checkSession).toHaveBeenCalledOnce()
    expect(await person.authenticate()).not.toBeNull()
    expect(checkSession).toHaveBeenCalledOnce()
  })

  it('groupから外れたら同じIdP identityのsessionを失効し、tokenも消す', async () => {
    const person = await fixture()
    const other = await sessions.createSession({ userId: person.user.id, lifetime, oidc: { issuer, subject: 'subject', sid: 'other' } })
    await person.makeDue()
    checkSession.mockImplementation(async tokens => ({ groups: [], tokens }))
    expect(await person.authenticate()).toBeNull()
    expect(await sessions.authenticateSession(other.token, 3600)).toBeNull()
    const stored = await pools.rw.query('SELECT revoked_at, oidc_access_token_enc, oidc_refresh_token_enc FROM auth_sessions WHERE user_id = $1', [person.user.id])
    expect(stored.rows.every(row => row.revoked_at && !row.oidc_access_token_enc && !row.oidc_refresh_token_enc)).toBe(true)
    const events = await pools.rw.query("SELECT details FROM audit_events WHERE action = 'auth.oidc.recheck'")
    expect(events.rows).toEqual([{ details: { reason: 'group_not_allowed' } }])
  })

  it('admin groupを失ったsessionは、一般groupに残っていても古い権限を使えない', async () => {
    const person = await fixture(['admin'])
    await person.makeDue()
    expect(await person.authenticate()).toBeNull()
  })

  it('更新したtokenは暗号化して保存し、平文をDBに残さない', async () => {
    const person = await fixture()
    await person.makeDue()
    checkSession.mockResolvedValue({ groups: ['mado-users'], tokens: {
      accessToken: 'rotated-access-secret', refreshToken: 'rotated-refresh-secret', expiresAt: new Date(Date.now() + 300_000),
    } })
    expect(await person.authenticate()).not.toBeNull()
    const stored = await pools.rw.query('SELECT oidc_access_token_enc, oidc_refresh_token_enc FROM auth_sessions WHERE id = $1', [person.session.id])
    expect(JSON.stringify(stored.rows)).not.toContain('rotated-')
    expect(crypto.decrypt(stored.rows[0].oidc_access_token_enc)).toBe('rotated-access-secret')
    expect(crypto.decrypt(stored.rows[0].oidc_refresh_token_enc)).toBe('rotated-refresh-secret')
  })

  it('IdPが停止したら権限を通さず、復旧後は同じsessionを再確認できる', async () => {
    const person = await fixture()
    await person.makeDue()
    checkSession.mockRejectedValueOnce(new Error('offline'))
    await expect(person.authenticate()).rejects.toThrow(OidcSessionCheckUnavailableError)
    expect(await person.authenticate()).not.toBeNull()
  })

  it('refresh tokenが無効なら再ログインさせ、同じ失敗を503で繰り返さない', async () => {
    const person = await fixture()
    await person.makeDue()
    checkSession.mockRejectedValue(Object.assign(new Error('invalid refresh token'), { error: 'invalid_grant', code: 'OAUTH_RESPONSE_BODY_ERROR', status: 400 }))
    expect(await person.authenticate()).toBeNull()
    expect(await person.authenticate()).toBeNull()
    expect(checkSession).toHaveBeenCalledOnce()
  })

  it('移行前のsessionだけを失効し、新しく作ったsessionやlocal loginを巻き込まない', async () => {
    const person = await fixture()
    const legacy = await sessions.createSession({ userId: person.user.id, lifetime, oidc: { issuer, subject: 'subject', sid: 'legacy' } })
    const local = await sessions.createSession({ userId: person.user.id, lifetime })
    expect(await sessions.authenticateSession(legacy.token, 3600)).toBeNull()
    expect(await person.authenticate()).not.toBeNull()
    expect(await sessions.authenticateSession(local.token, 3600)).not.toBeNull()
  })
})
