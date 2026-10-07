import type { Pool } from 'pg'
import { withTransaction } from '../db.js'
import type { CryptoModule } from '../crypto.js'
import type { AuditWriter } from './audit.js'
import type { AuthUser } from './auth-types.js'
import { OidcSessionExpiredError, type OidcProvider } from './auth-oidc.js'
import { resolveOidcRoles, type OidcRolePolicy } from './auth-oidc-provisioning.js'
import { SharedRequests } from './shared-requests.js'

// 各sessionを1分ごとにIdPへ確認し、常時アクセスでもgroup変更を拾う。
const RECHECK_INTERVAL_MS = 60_000

function isFresh(row: OidcSessionRow): boolean {
  return row.oidc_checked_at != null && Date.now() - row.oidc_checked_at.getTime() < RECHECK_INTERVAL_MS
    && row.oidc_token_expires_at != null && row.oidc_token_expires_at.getTime() > Date.now()
}

export interface OidcSessionRow {
  session_id: string
  oidc_issuer: string | null
  oidc_subject: string | null
  oidc_access_token_enc: string | null
  oidc_refresh_token_enc: string | null
  oidc_token_expires_at: Date | null
  oidc_checked_at: Date | null
}

export class OidcSessionCheckUnavailableError extends Error {
  constructor() { super('SSO session check is unavailable'); this.name = 'OidcSessionCheckUnavailableError' }
}

export function createOidcSessionVerifier({ pool, crypto, provider, policy, audit }: {
  pool: Pool; crypto: CryptoModule; provider: OidcProvider; policy: OidcRolePolicy; audit: AuditWriter
}) {
  const checks = new SharedRequests<boolean>()

  async function revoke(row: OidcSessionRow, user: AuthUser, reason: string): Promise<false> {
    await withTransaction(pool, async client => {
      await client.query(
        `UPDATE auth_sessions SET revoked_at = now(), oidc_access_token_enc = NULL, oidc_refresh_token_enc = NULL
          WHERE (id = $1 OR ($4 AND oidc_issuer = $2 AND oidc_subject = $3)) AND revoked_at IS NULL`,
        [row.session_id, row.oidc_issuer, row.oidc_subject, reason === 'group_not_allowed' || reason === 'roles_changed'],
      )
      await audit.write({
        actor: { type: 'user', userId: user.id }, action: 'auth.oidc.recheck', outcome: 'denied',
        resourceType: 'session', resourceId: row.session_id, details: { reason },
      }, client)
    })
    return false
  }

  return async (row: OidcSessionRow, user: AuthUser): Promise<boolean> => {
    if (!row.oidc_issuer) return true
    if (!row.oidc_access_token_enc || !row.oidc_token_expires_at || !row.oidc_subject) return revoke(row, user, 'reauthentication_required')
    if (isFresh(row)) return true
    return checks.run({ key: row.session_id, load: async () => {
      // 待機中に別の要求が更新したtokenを使う。古いrefresh tokenの再利用を避ける。
      const current = await pool.query<OidcSessionRow>(
        `SELECT id AS session_id, oidc_issuer, oidc_subject, oidc_access_token_enc,
            oidc_refresh_token_enc, oidc_token_expires_at, oidc_checked_at
           FROM auth_sessions WHERE id = $1 AND revoked_at IS NULL`, [row.session_id],
      )
      const latest = current.rows[0]
      if (!latest) return false
      row = latest
      if (isFresh(row)) return true
      if (!row.oidc_access_token_enc || !row.oidc_token_expires_at || !row.oidc_subject) return revoke(row, user, 'reauthentication_required')
      if (!provider.checkSession || !provider.matchesIssuer(row.oidc_issuer!)) return revoke(row, user, 'provider_changed')
      let checked
      try {
        checked = await provider.checkSession({
          accessToken: crypto.decrypt(row.oidc_access_token_enc!),
          refreshToken: row.oidc_refresh_token_enc ? crypto.decrypt(row.oidc_refresh_token_enc) : undefined,
          expiresAt: row.oidc_token_expires_at!,
        }, row.oidc_subject!)
      } catch (error) {
        const status = (error as { status?: number }).status
        const code = (error as { error?: string; code?: string }).error ?? (error as { code?: string }).code
        if (error instanceof OidcSessionExpiredError || status === 401 || code === 'invalid_grant' || code === 'invalid_token') {
          return revoke(row, user, 'idp_session_revoked')
        }
        throw new OidcSessionCheckUnavailableError()
      }
      const roles = resolveOidcRoles(policy, checked.groups)
      if (!roles.allowed) return revoke(row, user, 'group_not_allowed')
      if (roles.managedRoles && JSON.stringify([...roles.managedRoles].sort()) !== JSON.stringify([...user.roles].sort())) {
        return revoke(row, user, 'roles_changed')
      }
      const updated = await pool.query(
        `UPDATE auth_sessions SET oidc_checked_at = now(), oidc_access_token_enc = $2,
            oidc_refresh_token_enc = $3, oidc_token_expires_at = $4
          WHERE id = $1 AND revoked_at IS NULL AND oidc_access_token_enc = $5`,
        [row.session_id, crypto.encrypt(checked.tokens.accessToken),
          checked.tokens.refreshToken ? crypto.encrypt(checked.tokens.refreshToken) : null,
          checked.tokens.expiresAt, row.oidc_access_token_enc],
      )
      return (updated.rowCount ?? 0) > 0
    } })
  }
}
