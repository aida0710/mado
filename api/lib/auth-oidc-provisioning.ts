import type { Pool, PoolClient } from 'pg'
import { withTransaction } from '../db.js'
import type { AuditWriter } from './audit.js'
import type { AuthUser, RequestMetadata } from './auth-types.js'
import { loadUser, loadUserIncludingDeleted, normalizeLoginName, replaceRoleRows, sameRoleSet } from './auth-user-query.js'
import { ADMIN_ROLE, assertAdminRemovalAllowed, LastActiveAdminError } from './auth-admin-invariant.js'
import { insertUserRow } from './auth-user-store.js'

// SSO (OIDC) で入ってきた人を Mado の User に結び付ける: 既存 identity の検索、検証済み email での
// 既存 User への連携、JIT 作成、表示名などの同期、IdP の group からの Role 同期。

/** 特権を持たない Role。email の自動連携は、この Role だけを持つ User に限る。 */
const UNPRIVILEGED_ROLE = 'viewer'
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

export type OidcRole = 'viewer' | 'curator' | 'operator' | 'admin'

export interface OidcRolePolicy {
  allowedGroups: string[]
  roleMapping: Record<string, OidcRole>
  defaultRole: OidcRole
}

/** SSO での login を断った理由。利用者には区別せず 401 を返し、運用者向けに log へ出す。 */
export type OidcLoginDenialReason =
  | 'group_not_allowed'
  | 'deleted_user_email'
  | 'privileged_link_required'
  | 'user_disabled'
  | 'last_admin'

export class OidcLoginDeniedError extends Error {
  constructor(readonly reason: OidcLoginDenialReason) {
    super(`oidc login denied: ${reason}`)
    this.name = 'OidcLoginDeniedError'
  }
}

/**
 * IdP の group から、login を許すかと、同期する Role を決める。
 * roleMapping が空なら Role は Mado 側で管理する (managedRoles を返さない)。
 */
export function resolveOidcRoles(
  policy: OidcRolePolicy,
  groups: readonly string[],
): { allowed: false } | { allowed: true; managedRoles?: OidcRole[] } {
  if (!groups.some(group => policy.allowedGroups.includes(group))) return { allowed: false }
  if (Object.keys(policy.roleMapping).length === 0) return { allowed: true }
  const mapped = [...new Set(groups.map(group => policy.roleMapping[group]).filter(Boolean))]
  return { allowed: true, managedRoles: mapped.length > 0 ? mapped : [policy.defaultRole] }
}

export interface OidcProvisionInput {
  issuer: string
  subject: string
  email?: string | null
  emailVerified: boolean
  username?: string | null
  displayName: string
  groups: string[]
  autoLinkVerifiedEmail: boolean
  defaultRole: string
  /** 渡すと User の Role をこれに合わせる。undefined なら Role は触らない。 */
  managedRoles?: string[]
  /** 同期の監査に残す、login した request の情報。 */
  metadata?: RequestMetadata
}

export interface OidcProvisionResult {
  user: AuthUser
  created: boolean
  linkedExisting: boolean
  rolesBefore: string[]
  profileChanged: boolean
}

export interface OidcProvisioning {
  provisionOidcUser(input: OidcProvisionInput): Promise<OidcProvisionResult>
}

async function findLinkedUserId(client: PoolClient, input: OidcProvisionInput): Promise<string | null> {
  const identity = await client.query<{ user_id: string }>(
    `SELECT user_id FROM auth_oidc_identities WHERE issuer = $1 AND subject = $2 FOR UPDATE`,
    [input.issuer, input.subject],
  )
  return identity.rows[0]?.user_id ?? null
}

/** 検証済み email が一致する既存 User を探す。特権を持つ User への自動連携は乗っ取りになるので断る。 */
async function findVerifiedEmailUserId(client: PoolClient, email: string): Promise<string | null> {
  const match = await client.query<{ id: string; deleted_at: Date | null }>(
    `SELECT id, deleted_at FROM auth_users WHERE lower(email) = lower($1) FOR UPDATE`,
    [email],
  )
  const row = match.rows[0]
  if (!row) return null
  if (row.deleted_at) throw new OidcLoginDeniedError('deleted_user_email')
  const candidate = await loadUserIncludingDeleted(client, row.id)
  if (!candidate || candidate.roles.some(role => role !== UNPRIVILEGED_ROLE)) {
    throw new OidcLoginDeniedError('privileged_link_required')
  }
  return row.id
}

async function createJitUser(client: PoolClient, input: OidcProvisionInput): Promise<string> {
  const candidate = normalizeLoginName(input.username)
  const username = candidate && USERNAME_PATTERN.test(candidate) ? candidate : null
  const usernameTaken = username
    ? (await client.query(`SELECT 1 FROM auth_users WHERE lower(username) = lower($1)`, [username])).rowCount !== 0
    : false
  return insertUserRow(client, {
    username: usernameTaken ? null : username,
    email: input.emailVerified ? normalizeLoginName(input.email) : null,
    displayName: input.displayName,
    status: 'active',
    roles: input.managedRoles ?? [input.defaultRole],
    grantedBy: null,
  })
}

/** identity の最終 login 情報と、IdP 側で変わりうる表示名・検証済み email を取り込む。 */
async function syncOidcProfile(client: PoolClient, userId: string, input: OidcProvisionInput): Promise<void> {
  await client.query(
    `INSERT INTO auth_oidc_identities
       (issuer, subject, user_id, email_at_login, email_verified, groups_at_login)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (issuer, subject) DO UPDATE
       SET email_at_login = EXCLUDED.email_at_login,
           email_verified = EXCLUDED.email_verified,
           groups_at_login = EXCLUDED.groups_at_login,
           last_login_at = now()`,
    [input.issuer, input.subject, userId, input.email ?? null, input.emailVerified, input.groups],
  )
  await client.query(
    `UPDATE auth_users
        SET display_name = $2,
            email = CASE WHEN $3 THEN lower($4) ELSE email END,
            last_login_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL`,
    [userId, input.displayName.trim(), input.emailVerified && Boolean(input.email), input.email ?? null],
  )
}

export function createOidcProvisioning(pool: Pool, audit: AuditWriter): OidcProvisioning {
  return {
    provisionOidcUser: input => withTransaction(pool, async client => {
      let userId = await findLinkedUserId(client, input)
      let linkedExisting = false
      if (!userId && input.autoLinkVerifiedEmail && input.emailVerified && input.email) {
        userId = await findVerifiedEmailUserId(client, input.email)
        linkedExisting = userId !== null
      }
      const created = !userId
      if (!userId) userId = await createJitUser(client, input)

      const before = await loadUserIncludingDeleted(client, userId)
      if (!before) throw new Error('oidc user missing')
      if (before.status !== 'active') throw new OidcLoginDeniedError('user_disabled')
      const managedRolesChanged = input.managedRoles !== undefined && !sameRoleSet(before.roles, input.managedRoles)
      if (managedRolesChanged && before.roles.includes(ADMIN_ROLE) && !input.managedRoles!.includes(ADMIN_ROLE)) {
        try {
          await assertAdminRemovalAllowed(client, userId)
        } catch (error) {
          if (error instanceof LastActiveAdminError) throw new OidcLoginDeniedError('last_admin')
          throw error
        }
      }

      await syncOidcProfile(client, userId, input)
      if (managedRolesChanged) {
        await replaceRoleRows(client, { userId, roles: input.managedRoles!, grantedBy: null })
      }
      const user = await loadUser(client, userId)
      if (!user) throw new Error('oidc user disappeared')
      const profileChanged = before.displayName !== user.displayName
        || before.email !== user.email
        || managedRolesChanged

      // Role の昇格を含むので、同期と同じ transaction で監査に残す。
      if (created || linkedExisting || profileChanged) {
        await audit.write({
          actor: { type: 'user', userId }, action: 'auth.oidc.sync', outcome: 'success',
          resourceType: 'user', resourceId: userId,
          details: { created, linkedExisting, rolesBefore: before.roles, rolesAfter: user.roles },
          ...input.metadata,
        }, client)
      }
      return { user, created, linkedExisting, rolesBefore: before.roles, profileChanged }
    }),
  }
}
