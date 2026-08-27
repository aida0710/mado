import { Hono } from 'hono'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createAuditWriter } from '../lib/audit.js'
import { createAuthStore } from '../lib/auth-store.js'
import type { OidcProvider } from '../lib/auth-oidc.js'
import { hashPassword } from '../lib/password.js'
import { mountAuthRoutes } from './auth.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const store = createAuthStore(pools.rw)
const audit = createAuditWriter(pools.rw)
const app = new Hono()
mountAuthRoutes(app, {
  store,
  audit,
  config: {
    localEnabled: true,
    session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false, cookieName: 'mado_session' },
  },
})

beforeEach(async () => {
  await pools.rw.query('TRUNCATE auth_oidc_logout_events, audit_events, service_accounts, auth_users CASCADE')
  const user = await store.createUser({ username: 'local-user', email: 'user@example.com', displayName: 'User', roles: ['viewer'] })
  await store.setLocalPassword(user.id, await hashPassword('correct-password-123'), false)
})
afterAll(() => closePools(pools))

describe('auth routes', () => {
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
  })

  it('password誤りはgeneric 401でauditし、sessionを発行しない', async () => {
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
    expect(events.rows).toEqual([{ outcome: 'denied' }])
  })

  it('cookie無しの/meを401にする', async () => {
    expect((await app.request('/me')).status).toBe(401)
  })

  it('一時passwordのsessionは変更完了までprofileを拒否する', async () => {
    const user = (await store.getLocalCredential('local-user'))!
    await store.setLocalPassword(user.id, await hashPassword('temporary-password-123'), true)
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
      store, audit,
      config: {
        localEnabled: true,
        session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false, cookieName: 'mado_session' },
        oidc,
        oidcProvisioning: {
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
    const linked = await store.getLocalCredential('local-user')
    expect(linked).toMatchObject({ displayName: 'SSO User', roles: ['admin'] })
    expect(linked?.authMethods).toEqual(['local', 'sso'])
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
      store, audit,
      config: {
        localEnabled: false,
        session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false, cookieName: 'mado_session' },
        oidc,
        oidcProvisioning: {
          autoLinkVerifiedEmail: false, allowedGroups: ['mado-users'], roleMapping: {}, defaultRole: 'viewer',
        },
      },
    })
    expect((await oidcApp.request('/oidc/callback?code=ok&state=ok')).status).toBe(401)
  })

  it('Back-channel logoutを一度だけ受理して該当sessionを失効する', async () => {
    const user = (await store.getLocalCredential('local-user'))!
    const session = await store.createSession(user.id, { idleSeconds: 3600, absoluteSeconds: 7200 }, {}, {
      issuer: 'https://auth.example/application/o/mado', subject: 'subject-1', sid: 'sid-1',
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
      store, audit,
      config: {
        localEnabled: false,
        session: { idleSeconds: 3600, absoluteSeconds: 7200, secure: false, cookieName: 'mado_session' },
        oidc,
      },
    })
    const request = () => oidcApp.request('/oidc/backchannel-logout', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'logout_token=signed-token-placeholder',
    })
    expect((await request()).status).toBe(204)
    expect(await store.authenticateSession(session.token, 3600)).toBeNull()
    expect((await request()).status).toBe(400)
  })
})
