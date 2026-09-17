import type { Pool } from 'pg'
import * as oidc from 'openid-client'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { CryptoModule } from '../crypto.js'
import { sha256 } from './auth-crypto.js'

export interface OidcProviderConfig {
  id: string
  label: string
  issuerUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes?: string
  postLogoutRedirectUri?: string
}

export interface OidcProfile {
  issuer: string
  subject: string
  email: string | null
  emailVerified: boolean
  username: string | null
  displayName: string
  groups: string[]
  sid: string | null
  returnTo: string
}

export interface OidcLogoutClaims {
  issuer: string
  subject: string | null
  sid: string | null
  jti: string
  expiresAt: Date
}

interface AttemptRow {
  nonce_enc: string
  code_verifier_enc: string
  return_to: string
}

export class OidcAttemptLimitError extends Error {
  constructor() {
    super('too many pending oidc attempts')
    this.name = 'OidcAttemptLimitError'
  }
}

export interface OidcProvider {
  id: string
  label: string
  issuer: string
  start(returnTo: string | undefined, browserBinding: string): Promise<URL>
  finish(callbackUrl: URL, browserBinding: string): Promise<OidcProfile>
  logoutUrl(): Promise<URL>
  matchesIssuer(value: string): boolean
  verifyBackchannelLogoutToken(token: string): Promise<OidcLogoutClaims>
  deleteExpiredAttempts(): Promise<number>
}

export function safeReturnTo(value: string | undefined): string {
  const unsafe = (candidate: string) => [...candidate].some(char => {
    const code = char.charCodeAt(0)
    return char === '\\' || code < 0x20 || code === 0x7f
  })
  if (!value || value.length > 2048 || unsafe(value)) return '/'
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { return '/' }
  if (unsafe(decoded) || decoded.startsWith('//')) return '/'
  try {
    const base = new URL('https://mado.invalid/')
    const resolved = new URL(value, base)
    if (resolved.origin !== base.origin || !resolved.pathname.startsWith('/')) return '/'
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return '/'
  }
}

function canonicalIssuer(value: string): string {
  return value.replace(/\/$/, '')
}

function stringArrayClaim(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string =>
    typeof item === 'string' && item.trim() !== '' && item.length <= 256)
    .map(item => item.trim()))].slice(0, 256)
}

export function createOidcProvider(
  pool: Pool,
  crypto: CryptoModule,
  provider: OidcProviderConfig,
): OidcProvider {
  const issuer = new URL(provider.issuerUrl)
  const issuerId = canonicalIssuer(issuer.href)
  const redirectUri = new URL(provider.redirectUri)
  const postLogoutRedirectUri = new URL(provider.postLogoutRedirectUri ?? '/', redirectUri)
  let configuration: Promise<oidc.Configuration> | undefined
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

  const getConfiguration = () => {
    configuration ??= oidc.discovery(issuer, provider.clientId, provider.clientSecret)
    return configuration
  }

  return {
    id: provider.id,
    label: provider.label,
    issuer: issuerId,

    async start(returnTo, browserBinding) {
      if (browserBinding.length < 32 || browserBinding.length > 256) throw new Error('invalid oidc browser binding')
      const config = await getConfiguration()
      const state = oidc.randomState()
      const nonce = oidc.randomNonce()
      const verifier = oidc.randomPKCECodeVerifier()
      const challenge = await oidc.calculatePKCECodeChallenge(verifier)
      const bindingHash = sha256(browserBinding)
      const pending = await pool.query<{ own: string; total: string }>(
        `SELECT count(*) FILTER (WHERE browser_binding_hash = $1)::text AS own,
                count(*)::text AS total
           FROM auth_oidc_attempts
          WHERE used_at IS NULL AND expires_at > now()`,
        [bindingHash],
      )
      if (Number(pending.rows[0]?.own ?? 0) >= 3 || Number(pending.rows[0]?.total ?? 0) >= 10_000) {
        throw new OidcAttemptLimitError()
      }
      await pool.query(
        `INSERT INTO auth_oidc_attempts
          (state_hash, provider_id, nonce_enc, code_verifier_enc, return_to,
           browser_binding_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '5 minutes')`,
        [sha256(state), provider.id, crypto.encrypt(nonce), crypto.encrypt(verifier),
          safeReturnTo(returnTo), bindingHash],
      )
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri.href,
        scope: provider.scopes ?? 'openid email profile',
        response_type: 'code',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
    },

    async finish(callbackUrl, browserBinding) {
      if (browserBinding.length < 32 || browserBinding.length > 256) throw new Error('invalid oidc browser binding')
      const state = callbackUrl.searchParams.get('state')
      if (!state || state.length > 512) throw new Error('invalid oidc state')
      const attempt = await pool.query<AttemptRow>(
        `UPDATE auth_oidc_attempts SET used_at = now()
          WHERE state_hash = $1 AND provider_id = $2 AND browser_binding_hash = $3
            AND used_at IS NULL AND expires_at > now()
          RETURNING nonce_enc, code_verifier_enc, return_to`,
        [sha256(state), provider.id, sha256(browserBinding)],
      )
      const row = attempt.rows[0]
      if (!row) throw new Error('invalid or expired oidc state')

      const currentUrl = new URL(redirectUri.href)
      currentUrl.search = callbackUrl.search
      const tokens = await oidc.authorizationCodeGrant(
        await getConfiguration(),
        currentUrl,
        {
          expectedState: state,
          expectedNonce: crypto.decrypt(row.nonce_enc),
          pkceCodeVerifier: crypto.decrypt(row.code_verifier_enc),
          idTokenExpected: true,
        },
      )
      const claims = tokens.claims()
      if (!claims?.sub || claims.sub.length > 512) throw new Error('oidc subject missing')
      const email = typeof claims.email === 'string' && claims.email.length <= 320 ? claims.email : null
      const username = typeof claims.preferred_username === 'string'
        ? claims.preferred_username.trim() || null
        : null
      const displayName = ([claims.name, claims.preferred_username, email, claims.sub]
        .find(v => typeof v === 'string' && v.trim() !== '') as string
      ).trim().slice(0, 128)
      return {
        issuer: issuerId,
        subject: claims.sub,
        email,
        emailVerified: claims.email_verified === true,
        username,
        displayName,
        groups: stringArrayClaim(claims.groups),
        sid: typeof claims.sid === 'string' && claims.sid.length <= 512 ? claims.sid : null,
        returnTo: row.return_to,
      }
    },

    async logoutUrl() {
      return oidc.buildEndSessionUrl(await getConfiguration(), {
        post_logout_redirect_uri: postLogoutRedirectUri.href,
      })
    },

    matchesIssuer(value) {
      return canonicalIssuer(value) === issuerId
    },

    async verifyBackchannelLogoutToken(token) {
      if (token.length < 32 || token.length > 16_384) throw new Error('invalid logout token')
      const config = await getConfiguration()
      const metadata = config.serverMetadata()
      if (!metadata.jwks_uri) throw new Error('oidc jwks_uri missing')
      jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri))
      const expectedIssuer = metadata.issuer ?? issuer.href
      const verified = await jwtVerify(token, jwks, {
        issuer: expectedIssuer,
        audience: provider.clientId,
        clockTolerance: 60,
        maxTokenAge: '10 minutes',
      })
      const claims = verified.payload
      const eventName = 'http://schemas.openid.net/event/backchannel-logout'
      if (!claims.events || typeof claims.events !== 'object'
          || !(eventName in claims.events) || claims.nonce !== undefined) {
        throw new Error('invalid logout token events')
      }
      const subject = typeof claims.sub === 'string' ? claims.sub : null
      const sid = typeof claims.sid === 'string' ? claims.sid : null
      if (!subject && !sid) throw new Error('logout token subject missing')
      if (typeof claims.jti !== 'string' || claims.jti.length > 512) {
        throw new Error('logout token jti missing')
      }
      return {
        issuer: issuerId,
        subject,
        sid,
        jti: claims.jti,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }
    },

    async deleteExpiredAttempts() {
      const r = await pool.query(
        `DELETE FROM auth_oidc_attempts
          WHERE expires_at < now() - interval '1 hour' OR used_at < now() - interval '1 hour'`,
      )
      return r.rowCount ?? 0
    },
  }
}
