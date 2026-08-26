import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closePools, createPools } from '../db.js'
import { createCrypto } from '../crypto.js'

const oidcMocks = vi.hoisted(() => ({
  grant: vi.fn(),
  build: vi.fn(),
  endSession: vi.fn(),
}))

vi.mock('openid-client', () => ({
  discovery: vi.fn().mockResolvedValue({ serverMetadata: () => ({}) }),
  randomState: vi.fn(() => 'state-value'),
  randomNonce: vi.fn(() => 'nonce-value'),
  randomPKCECodeVerifier: vi.fn(() => 'verifier-value'),
  calculatePKCECodeChallenge: vi.fn().mockResolvedValue('challenge-value'),
  buildAuthorizationUrl: oidcMocks.build.mockImplementation((_cfg, params) => {
    const u = new URL('https://auth.example/authorize')
    for (const [k, v] of Object.entries(params as Record<string, string>)) u.searchParams.set(k, v)
    return u
  }),
  buildEndSessionUrl: oidcMocks.endSession.mockImplementation((_cfg, params) => {
    const u = new URL('https://auth.example/end-session')
    for (const [k, v] of Object.entries(params as Record<string, string>)) u.searchParams.set(k, v)
    return u
  }),
  authorizationCodeGrant: oidcMocks.grant.mockResolvedValue({
    claims: () => ({
      sub: 'subject-1', email: 'user@example.com', email_verified: true,
      preferred_username: 'user', name: 'User', groups: ['mado-users', 'mado-admins'], sid: 'session-1',
    }),
  }),
}))

import { createOidcProvider } from './auth-oidc.js'

const RW = process.env.DATABASE_URL_RW_TEST
  ?? 'postgres://dashboard_rw:CHANGEME@localhost:5432/dashboard_test'
const pools = createPools({ rw: RW, ro: RW.replace('dashboard_rw', 'dashboard_ro') })
const crypto = createCrypto('a'.repeat(64))

beforeEach(async () => {
  oidcMocks.grant.mockClear()
  await pools.rw.query('TRUNCATE auth_oidc_attempts')
})
afterAll(() => closePools(pools))

describe('OidcProvider', () => {
  it('PKCE/state/nonceを保存し、callbackを一度だけ消費する', async () => {
    const provider = createOidcProvider(pools.rw, crypto, {
      id: 'authentik', label: 'Authentik', issuerUrl: 'https://auth.example/application/o/mado/',
      clientId: 'client', clientSecret: 'secret', redirectUri: 'https://mado.example/api/auth/oidc/callback',
    })
    const start = await provider.start('/lineage')
    expect(start.searchParams.get('state')).toBe('state-value')
    expect(start.searchParams.get('nonce')).toBe('nonce-value')
    expect(start.searchParams.get('code_challenge_method')).toBe('S256')

    const stored = await pools.rw.query<{
      state_hash: Buffer; nonce_enc: string; code_verifier_enc: string
    }>('SELECT state_hash, nonce_enc, code_verifier_enc FROM auth_oidc_attempts')
    expect(stored.rows[0].state_hash).toHaveLength(32)
    expect(stored.rows[0].nonce_enc).not.toContain('nonce-value')
    expect(stored.rows[0].code_verifier_enc).not.toContain('verifier-value')

    const callback = new URL('https://attacker.invalid/callback?code=abc&state=state-value')
    const profile = await provider.finish(callback)
    expect(profile).toMatchObject({
      subject: 'subject-1', returnTo: '/lineage', emailVerified: true, username: 'user',
      groups: ['mado-users', 'mado-admins'], sid: 'session-1',
    })
    // Host header由来URLでなく、設定済みredirect URIをtoken exchangeへ渡す。
    expect(oidcMocks.grant.mock.calls[0][1].origin).toBe('https://mado.example')
    await expect(provider.finish(callback)).rejects.toThrow(/invalid or expired/)
  })

  it('RP-Initiated Logout URLにMadoへの戻り先を設定する', async () => {
    const provider = createOidcProvider(pools.rw, crypto, {
      id: 'authentik', label: 'Authentik', issuerUrl: 'https://auth.example/application/o/mado/',
      clientId: 'client', clientSecret: 'secret', redirectUri: 'https://mado.example/api/auth/oidc/callback',
      postLogoutRedirectUri: 'https://mado.example/',
    })
    const url = await provider.logoutUrl()
    expect(url.href).toBe('https://auth.example/end-session?post_logout_redirect_uri=https%3A%2F%2Fmado.example%2F')
  })

  it('外部URLへのreturnToをrootへ正規化する', async () => {
    const provider = createOidcProvider(pools.rw, crypto, {
      id: 'authentik', label: 'Authentik', issuerUrl: 'https://auth.example/',
      clientId: 'client', clientSecret: 'secret', redirectUri: 'https://mado.example/api/auth/oidc/callback',
    })
    await provider.start('//evil.example')
    const r = await pools.rw.query<{ return_to: string }>('SELECT return_to FROM auth_oidc_attempts')
    expect(r.rows[0].return_to).toBe('/')
  })
})
