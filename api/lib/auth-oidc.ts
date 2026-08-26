import type { Pool } from 'pg'
import * as oidc from 'openid-client'
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
}

export interface OidcProfile {
  issuer: string
  subject: string
  email: string | null
  displayName: string
  returnTo: string
}

interface AttemptRow {
  nonce_enc: string
  code_verifier_enc: string
  return_to: string
}

export interface OidcProvider {
  id: string
  label: string
  start(returnTo?: string): Promise<URL>
  finish(callbackUrl: URL): Promise<OidcProfile>
  deleteExpiredAttempts(): Promise<number>
}

function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.length > 2048) return '/'
  return value
}

export function createOidcProvider(
  pool: Pool,
  crypto: CryptoModule,
  cfg: OidcProviderConfig,
): OidcProvider {
  const issuer = new URL(cfg.issuerUrl)
  const redirectUri = new URL(cfg.redirectUri)
  let configuration: Promise<oidc.Configuration> | undefined

  const getConfiguration = () => {
    configuration ??= oidc.discovery(issuer, cfg.clientId, cfg.clientSecret)
    return configuration
  }

  return {
    id: cfg.id,
    label: cfg.label,

    async start(returnTo) {
      const config = await getConfiguration()
      const state = oidc.randomState()
      const nonce = oidc.randomNonce()
      const verifier = oidc.randomPKCECodeVerifier()
      const challenge = await oidc.calculatePKCECodeChallenge(verifier)
      await pool.query(
        `INSERT INTO auth_oidc_attempts
          (state_hash, provider_id, nonce_enc, code_verifier_enc, return_to, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '5 minutes')`,
        [sha256(state), cfg.id, crypto.encrypt(nonce), crypto.encrypt(verifier), safeReturnTo(returnTo)],
      )
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri.href,
        scope: cfg.scopes ?? 'openid email profile',
        response_type: 'code',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
    },

    async finish(callbackUrl) {
      const state = callbackUrl.searchParams.get('state')
      if (!state || state.length > 512) throw new Error('invalid oidc state')
      const attempt = await pool.query<AttemptRow>(
        `UPDATE auth_oidc_attempts SET used_at = now()
          WHERE state_hash = $1 AND provider_id = $2 AND used_at IS NULL AND expires_at > now()
          RETURNING nonce_enc, code_verifier_enc, return_to`,
        [sha256(state), cfg.id],
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
      if (!claims?.sub) throw new Error('oidc subject missing')
      const email = typeof claims.email === 'string' ? claims.email : null
      const displayName = [claims.name, claims.preferred_username, email, claims.sub]
        .find(v => typeof v === 'string' && v.trim() !== '') as string
      return {
        issuer: issuer.href.replace(/\/$/, ''),
        subject: claims.sub,
        email,
        displayName,
        returnTo: row.return_to,
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
