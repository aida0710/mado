import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter, type AuditWriter } from '../lib/audit.js'
import { createUserStore } from '../lib/auth-user-store.js'
import { createCredentialStore } from '../lib/auth-credential-store.js'
import { createSessionStore } from '../lib/auth-session-store.js'
import { createOidcProvisioning } from '../lib/auth-oidc-provisioning.js'
import type { OidcProvider } from '../lib/auth-oidc.js'
import { AuthRateLimiter } from '../lib/auth-rate-limit.js'
import { hashPassword } from '../lib/password.js'
import { mountAuthRoutes } from './auth.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const users = createUserStore(pools.rw)
const credentials = createCredentialStore(pools.rw)
const audit = createAuditWriter(pools.rw)
const sessions = createSessionStore(pools.rw, audit)
const stores = { users, credentials, sessions, oidcProvisioning: createOidcProvisioning(pools.rw, audit) }
const app = new Hono()
mountAuthRoutes(app, {
  ...stores,
  audit,
  config: {
    localEnabled: true,
    session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false },
  },
})

beforeEach(async () => {
  await pools.rw.query('TRUNCATE auth_oidc_logout_events, audit_events, service_accounts, auth_users CASCADE')
  await users.createUser({
    username: 'local-user', email: 'user@example.com', displayName: 'User', roles: ['viewer'],
    localPassword: { hash: await hashPassword('correct-password-123'), mustChange: false },
  })
})
afterAll(() => closePools(pools))

describe('認証 route', () => {
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
    expect(await me.json()).toMatchObject({ user: {
      username: 'local-user', email: 'user@example.com', signatureName: 'User', roles: ['viewer'],
    } })

    const profile = await app.request('/profile', {
      method: 'PUT',
      headers: { Cookie: cookie!.split(';')[0], 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '新しい表示名', username: 'renamed-user', signatureName: '新しい署名' }),
    })
    expect(profile.status).toBe(200)
    expect(await profile.json()).toMatchObject({ user: {
      displayName: '新しい表示名', username: 'renamed-user', signatureName: '新しい署名',
    } })
    const events = await pools.rw.query<{ action: string; outcome: string; details: { changes: Array<{ field: string; before: unknown; after: unknown }> } }>(
      `SELECT action, outcome, details FROM audit_events WHERE action = 'auth.profile.update'`,
    )
    expect(events.rows[0]).toMatchObject({ action: 'auth.profile.update', outcome: 'success' })
    expect(events.rows[0].details.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'username', before: 'local-user', after: 'renamed-user' }),
    ]))

    await pools.rw.query(`DELETE FROM audit_events WHERE action = 'auth.profile.update'`)
    const sameProfile = await app.request('/profile', {
      method: 'PUT',
      headers: { Cookie: cookie!.split(';')[0], 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: '新しい表示名', username: 'renamed-user', signatureName: '新しい署名' }),
    })
    expect(sameProfile.status).toBe(200)
    const repeated = await pools.rw.query(
      `SELECT id FROM audit_events WHERE action = 'auth.profile.update'`,
    )
    expect(repeated.rows).toEqual([])
  })

  it('password誤りはgeneric 401で、変更監査やsessionを作らない', async () => {
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
    expect(events.rows).toEqual([])
  })

  it('password失敗をUser単位で拒否せず正しいpasswordは通す', async () => {
    const isolated = new Hono()
    mountAuthRoutes(isolated, {
      ...stores,
      audit,
      config: {
        localEnabled: true,
        session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false },
        rateLimiter: new AuthRateLimiter(),
      },
    })
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const denied = await isolated.request('/local/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'local-user', password: `wrong-${attempt}` }),
      })
      expect(denied.status).toBe(401)
    }
    const accepted = await isolated.request('/local/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'local-user', password: 'correct-password-123' }),
    })
    expect(accepted.status).toBe(200)
  })

  it('cookie無しの/meを401にする', async () => {
    expect((await app.request('/me')).status).toBe(401)
  })

  it('一時passwordのsessionは変更完了までprofileを拒否する', async () => {
    const user = (await credentials.findLocalCredentialByLogin('local-user'))!
    await credentials.resetLocalPassword(user.id, await hashPassword('temporary-password-123'))
    const login = await app.request('/local/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'local-user', password: 'temporary-password-123' }),
    })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    expect((await app.request('/me', { headers: { Cookie: cookie } })).status).toBe(200)
    expect((await app.request('/profile', {
      method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signatureName: '迂回' }),
    })).status).toBe(403)

    const changed = await app.request('/change-password', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'temporary-password-123', newPassword: 'changed-password-123' }),
    })
    expect(changed.status).toBe(200)
    const nextCookie = changed.headers.get('set-cookie')!.split(';')[0]
    expect((await app.request('/profile', {
      method: 'PUT', headers: { Cookie: nextCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signatureName: '変更後' }),
    })).status).toBe(200)
  })

  it('OIDC callbackで検証済みemailを既存Userへ連携しgroup roleを同期する', async () => {
    const oidc: OidcProvider = {
      id: 'primary', label: 'Authentik', issuer: 'https://auth.example/application/o/mado',
      start: async () => new URL('https://auth.example/authorize'),
      finish: async () => ({
        issuer: 'https://auth.example/application/o/mado', subject: 'subject-1',
        email: 'user@example.com', emailVerified: true, username: 'sso-user', displayName: 'SSO User',
        groups: ['mado-admins'], sid: 'sid-1', returnTo: '/lineage',
      }),
      logoutUrl: async () => new URL('https://auth.example/end-session'),
      matchesIssuer: value => value.replace(/\/$/, '') === 'https://auth.example/application/o/mado',
      verifyBackchannelLogoutToken: async () => { throw new Error('not used') },
      deleteExpiredAttempts: async () => 0,
    }
    const oidcApp = new Hono()
    mountAuthRoutes(oidcApp, {
      ...stores, audit,
      config: {
        localEnabled: true,
        session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false },
        oidc,
        oidcLoginPolicy: {
          autoLinkVerifiedEmail: true, allowedGroups: ['mado-admins'],
          roleMapping: { 'mado-admins': 'admin' }, defaultRole: 'viewer',
        },
      },
    })
    const started = await oidcApp.request('/oidc/start?returnTo=%2Flineage')
    const bindingCookie = started.headers.get('set-cookie')!.split(';')[0]
    const response = await oidcApp.request('/oidc/callback?code=ok&state=ok', {
      headers: { Cookie: bindingCookie },
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/lineage')
    const linked = await credentials.findLocalCredentialByLogin('local-user')
    expect(linked).toMatchObject({ displayName: 'SSO User', roles: ['admin'] })
    expect(linked?.authMethods).toEqual(['local', 'sso'])
    const synced = await pools.rw.query(`SELECT outcome FROM audit_events WHERE action = 'auth.oidc.sync'`)
    expect(synced.rows).toEqual([{ outcome: 'success' }])
  })

  it('OIDC callbackは開始browser cookieなしでは拒否する', async () => {
    const oidc: OidcProvider = {
      id: 'primary', label: 'Authentik', issuer: 'https://auth.example/application/o/mado',
      start: async () => new URL('https://auth.example/authorize'),
      finish: async () => ({
        issuer: 'https://auth.example/application/o/mado', subject: 'subject-1',
        email: null, emailVerified: false, username: null, displayName: 'SSO User',
        groups: ['mado-users'], sid: null, returnTo: '/',
      }),
      logoutUrl: async () => new URL('https://auth.example/end-session'),
      matchesIssuer: () => true,
      verifyBackchannelLogoutToken: async () => { throw new Error('not used') },
      deleteExpiredAttempts: async () => 0,
    }
    const oidcApp = new Hono()
    mountAuthRoutes(oidcApp, {
      ...stores, audit,
      config: {
        localEnabled: false,
        session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false },
        oidc,
        oidcLoginPolicy: {
          autoLinkVerifiedEmail: false, allowedGroups: ['mado-users'], roleMapping: {}, defaultRole: 'viewer',
        },
      },
    })
    expect((await oidcApp.request('/oidc/callback?code=ok&state=ok')).status).toBe(401)
  })

  it('Back-channel logoutを一度だけ受理して該当sessionを失効する', async () => {
    const user = (await credentials.findLocalCredentialByLogin('local-user'))!
    const session = await sessions.createSession({
      userId: user.id,
      lifetime: { idleSeconds: 3600, absoluteSeconds: 7200 },
      oidc: { issuer: 'https://auth.example/application/o/mado', subject: 'subject-1', sid: 'sid-1' },
    })
    const oidc: OidcProvider = {
      id: 'primary', label: 'Authentik', issuer: 'https://auth.example/application/o/mado',
      start: async () => new URL('https://auth.example/authorize'),
      finish: async () => { throw new Error('not used') },
      logoutUrl: async () => new URL('https://auth.example/end-session'),
      matchesIssuer: () => true,
      verifyBackchannelLogoutToken: async () => ({
        issuer: 'https://auth.example/application/o/mado', subject: 'subject-1', sid: 'sid-1',
        jti: 'logout-jti-1', expiresAt: new Date(Date.now() + 60_000),
      }),
      deleteExpiredAttempts: async () => 0,
    }
    const oidcApp = new Hono()
    mountAuthRoutes(oidcApp, {
      ...stores, audit,
      config: {
        localEnabled: false,
        session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false },
        oidc,
      },
    })
    const request = () => oidcApp.request('/oidc/backchannel-logout', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'logout_token=signed-token-placeholder',
    })
    expect((await request()).status).toBe(204)
    expect(await sessions.authenticateSession(session.token, 3600)).toBeNull()
    expect((await request()).status).toBe(400)
  })

  describe('パスワード変更', () => {
    async function loginCookie(target: Hono): Promise<string> {
      const login = await target.request('/local/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'local-user', password: 'correct-password-123' }),
      })
      return login.headers.get('set-cookie')!.split(';')[0]
    }
    const changePassword = (target: Hono, cookie: string, currentPassword: string) => target.request('/change-password', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword: 'changed-password-123' }),
    })

    it('監査の書き込みに失敗しても変更は成功として返し、変更前に残した記録を成功で確定する', async () => {
      const failingWrite = { ...audit, write: () => Promise.reject(new Error('audit unavailable')) } as AuditWriter
      const target = new Hono()
      mountAuthRoutes(target, {
        ...stores, audit: failingWrite,
        config: { localEnabled: true, session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false } },
      })
      const changed = await changePassword(target, await loginCookie(target), 'correct-password-123')
      expect(changed.status).toBe(200)
      expect(changed.headers.get('set-cookie')).toContain('mado_session=')
      const events = await pools.rw.query<{ outcome: string; details: Record<string, unknown> }>(
        `SELECT outcome, details FROM audit_events WHERE action = 'auth.password.change'`,
      )
      expect(events.rows).toEqual([expect.objectContaining({
        outcome: 'success', details: expect.objectContaining({ state: 'committed', dedicatedAuditMissing: true }),
      })])
    })

    it('現在のパスワードの確認は User ごとに回数を制限する', async () => {
      const target = new Hono()
      mountAuthRoutes(target, {
        ...stores, audit,
        config: {
          localEnabled: true, rateLimiter: new AuthRateLimiter(),
          session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false },
        },
      })
      const cookie = await loginCookie(target)
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await changePassword(target, cookie, `wrong-${attempt}`)).status).toBe(400)
      }
      expect((await changePassword(target, cookie, 'correct-password-123')).status).toBe(429)
    })
  })

  describe('SSO', () => {
    const issuer = 'https://auth.example/application/o/mado'
    function oidcProvider(overrides: Partial<OidcProvider> = {}): OidcProvider {
      return {
        id: 'primary', label: 'Authentik', issuer,
        start: async () => new URL('https://auth.example/authorize'),
        finish: async () => ({
          issuer, subject: 'subject-1', email: null, emailVerified: false, username: null,
          displayName: 'SSO User', groups: ['others'], sid: 'sid-1', returnTo: '/',
        }),
        logoutUrl: async () => new URL('https://auth.example/end-session'),
        matchesIssuer: () => true,
        verifyBackchannelLogoutToken: async () => { throw new Error('not used') },
        deleteExpiredAttempts: async () => 0,
        ...overrides,
      }
    }
    function oidcApp(oidc: OidcProvider): Hono {
      const target = new Hono()
      mountAuthRoutes(target, {
        ...stores, audit,
        config: {
          localEnabled: false,
          session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false },
          oidc,
          oidcLoginPolicy: {
            autoLinkVerifiedEmail: false, allowedGroups: ['mado-users'], roleMapping: {}, defaultRole: 'viewer',
          },
        },
      })
      return target
    }

    it('callback で断った理由を、秘密値を含めずに log へ残す', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const target = oidcApp(oidcProvider())
        const started = await target.request('/oidc/start')
        const bindingCookie = started.headers.get('set-cookie')!.split(';')[0]
        const response = await target.request('/oidc/callback?code=secret-code&state=s', { headers: { Cookie: bindingCookie } })
        expect(response.status).toBe(401)
        expect(warn).toHaveBeenCalledWith('oidc login failed', expect.objectContaining({ reason: 'group_not_allowed' }))
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-code')
      } finally {
        warn.mockRestore()
      }
    })

    it('IdP の logout URL を作れなくても、Mado の session を失効させて成功を返す', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const user = (await credentials.findLocalCredentialByLogin('local-user'))!
        const session = await sessions.createSession({
          userId: user.id, lifetime: { idleSeconds: 3600, absoluteSeconds: 7200 },
          oidc: { issuer, subject: 'subject-1', sid: 'sid-1' },
        })
        const target = oidcApp(oidcProvider({ logoutUrl: async () => { throw new Error('connect ECONNREFUSED') } }))
        const response = await target.request('/logout', {
          method: 'POST', headers: { Cookie: `mado_session=${session.token}` },
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, logoutUrl: null })
        expect(await sessions.authenticateSession(session.token, 3600)).toBeNull()
      } finally {
        warn.mockRestore()
      }
    })
  })
})
