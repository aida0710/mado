import type { Pool, PoolClient } from 'pg'
import type { AuthUser, RequestMetadata, SessionPrincipal, UserStatus } from './auth-types.js'
import { newId, randomToken, sha256 } from './auth-crypto.js'

interface AuthUserRow {
  id: string
  username: string | null
  email: string | null
  display_name: string
  signature_name: string
  status: UserStatus
  roles: string[]
  permissions: string[]
  must_change_password: boolean
  auth_methods: Array<'local' | 'sso'>
}

interface LocalCredentialRow extends AuthUserRow {
  password_hash: string
}

const AUTH_USER_FIELDS = `u.id, u.username, u.email, u.display_name, u.signature_name, u.status,
         COALESCE((
           SELECT array_agg(ur.role_id ORDER BY ur.role_id)
             FROM auth_user_roles ur WHERE ur.user_id = u.id
         ), ARRAY[]::text[]) AS roles,
         COALESCE((
           SELECT array_agg(DISTINCT rp.permission_id ORDER BY rp.permission_id)
             FROM auth_user_roles ur
             JOIN auth_role_permissions rp ON rp.role_id = ur.role_id
            WHERE ur.user_id = u.id
         ), ARRAY[]::text[]) AS permissions,
         COALESCE(lc.must_change_password, FALSE) AS must_change_password,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN lc.user_id IS NOT NULL THEN 'local' END,
           CASE WHEN EXISTS (
             SELECT 1 FROM auth_oidc_identities oi WHERE oi.user_id = u.id
           ) THEN 'sso' END
         ], NULL)::text[] AS auth_methods`

const AUTH_USER_FROM = `FROM auth_users u
    LEFT JOIN auth_local_credentials lc ON lc.user_id = u.id`

const AUTH_USER_SELECT = `SELECT ${AUTH_USER_FIELDS} ${AUTH_USER_FROM}`

function toUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    signatureName: row.signature_name,
    status: row.status,
    roles: row.roles,
    permissions: row.permissions,
    mustChangePassword: row.must_change_password,
    authMethods: row.auth_methods,
  }
}

export interface CreateUserInput {
  username?: string | null
  email?: string | null
  displayName: string
  status?: UserStatus
  roles?: string[]
  createdBy?: string | null
}

export interface AuthUserMutationResult {
  before: AuthUser
  user: AuthUser
  changedFields: string[]
}

export interface AuthStore {
  listUsers(): Promise<AuthUser[]>
  getUser(id: string): Promise<AuthUser | null>
  createUser(input: CreateUserInput, client?: PoolClient): Promise<AuthUser>
  updateUser(id: string, patch: { username?: string | null; email?: string | null; displayName?: string; status?: UserStatus }): Promise<AuthUser | null>
  updateUserIfChanged(id: string, patch: { username?: string | null; email?: string | null; displayName?: string; status?: UserStatus }): Promise<AuthUserMutationResult | null>
  deleteUser(id: string): Promise<boolean>
  updateSignatureName(id: string, signatureName: string): Promise<AuthUser | null>
  setUserRoles(userId: string, roles: string[], grantedBy: string): Promise<AuthUser | null>
  setUserRolesIfChanged(userId: string, roles: string[], grantedBy: string): Promise<AuthUserMutationResult | null>
  updateProfileIfChanged(id: string, patch: { username?: string | null; displayName?: string; signatureName: string }): Promise<AuthUserMutationResult | null>
  rolesExist(roles: string[]): Promise<boolean>
  hasOtherActiveAdmin(userId: string): Promise<boolean>
  getLocalCredential(identifier: string): Promise<(AuthUser & {
    passwordHash: string
  }) | null>
  setLocalPassword(userId: string, hash: string, mustChange: boolean): Promise<boolean>
  recordSuccessfulLogin(userId: string): Promise<void>
  createSession(userId: string, cfg: SessionLifetime, metadata?: RequestMetadata, oidc?: OidcSessionContext): Promise<CreatedSession>
  authenticateSession(token: string, idleSeconds: number, touchIntervalSeconds?: number): Promise<SessionPrincipal | null>
  revokeSession(token: string): Promise<boolean>
  revokeUserSessions(userId: string): Promise<number>
  getSessionOidcContext(token: string): Promise<OidcSessionContext | null>
  revokeOidcSessions(input: { issuer: string; subject?: string | null; sid?: string | null }): Promise<number>
  applyOidcBackchannelLogout(input: OidcBackchannelLogout): Promise<{ accepted: boolean; revoked: number }>
  deleteExpiredSessions(): Promise<number>
  provisionOidcUser(input: OidcProvisionInput): Promise<OidcProvisionResult>
}

export interface SessionLifetime {
  idleSeconds: number
  absoluteSeconds: number
}

export interface CreatedSession {
  id: string
  token: string
  expiresAt: Date
}

export interface OidcSessionContext {
  issuer: string
  subject: string
  sid?: string | null
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
  managedRoles?: string[]
}

export interface OidcProvisionResult {
  user: AuthUser
  created: boolean
  linkedExisting: boolean
  rolesBefore: string[]
  profileChanged: boolean
}

export interface OidcBackchannelLogout {
  issuer: string
  subject?: string | null
  sid?: string | null
  jti: string
  expiresAt: Date
}

export class LastActiveAdminError extends Error {
  constructor() {
    super('cannot remove the last active admin')
    this.name = 'LastActiveAdminError'
  }
}

export function createAuthStore(pool: Pool): AuthStore {
  async function loadUserIncludingDeleted(id: string, client: Pool | PoolClient = pool): Promise<AuthUser | null> {
    const r = await client.query<AuthUserRow>(`${AUTH_USER_SELECT} WHERE u.id = $1`, [id])
    return r.rows[0] ? toUser(r.rows[0]) : null
  }

  async function loadUser(id: string, client: Pool | PoolClient = pool): Promise<AuthUser | null> {
    const r = await client.query<AuthUserRow>(`${AUTH_USER_SELECT} WHERE u.id = $1 AND u.deleted_at IS NULL`, [id])
    return r.rows[0] ? toUser(r.rows[0]) : null
  }

  async function assertAdminRemovalAllowed(client: PoolClient, userId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('mado-active-admin-invariant'))`)
    const target = await client.query<{ status: UserStatus; is_admin: boolean }>(
      `SELECT u.status,
              EXISTS (SELECT 1 FROM auth_user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin') AS is_admin
         FROM auth_users u
        WHERE u.id = $1 AND u.deleted_at IS NULL
        FOR UPDATE`,
      [userId],
    )
    if (target.rows[0]?.status !== 'active' || !target.rows[0]?.is_admin) return
    const admins = await client.query<{ count: string }>(
      `SELECT count(DISTINCT u.id)::text AS count
         FROM auth_users u
         JOIN auth_user_roles ur ON ur.user_id = u.id AND ur.role_id = 'admin'
        WHERE u.status = 'active' AND u.deleted_at IS NULL`,
    )
    if (Number(admins.rows[0]?.count ?? 0) <= 1) throw new LastActiveAdminError()
  }

  async function updateUserIfChanged(
    id: string,
    patch: { username?: string | null; email?: string | null; displayName?: string; status?: UserStatus },
  ): Promise<AuthUserMutationResult | null> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // 管理者不変条件を触る経路は全て advisory lock → user row の順に統一する。
      if (patch.status === 'disabled') await assertAdminRemovalAllowed(client, id)
      const locked = await client.query(
        `SELECT id FROM auth_users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id],
      )
      if (locked.rowCount === 0) {
        await client.query('ROLLBACK')
        return null
      }
      const before = await loadUser(id, client)
      if (!before) throw new Error('locked user disappeared')
      const normalized = {
        username: patch.username === undefined ? undefined : patch.username?.trim().toLowerCase() || null,
        email: patch.email === undefined ? undefined : patch.email?.trim().toLowerCase() || null,
        displayName: patch.displayName?.trim(),
        status: patch.status,
      }
      const changedFields = (Object.keys(normalized) as Array<keyof typeof normalized>)
        .filter(key => normalized[key] !== undefined && normalized[key] !== before[key])
      if (changedFields.length === 0) {
        await client.query('COMMIT')
        return { before, user: before, changedFields: [] }
      }
      const fields: string[] = []
      const values: unknown[] = []
      const columns = { username: 'username', email: 'email', displayName: 'display_name', status: 'status' } as const
      for (const key of changedFields) {
        values.push(normalized[key])
        fields.push(`${columns[key]} = $${values.length}`)
      }
      values.push(id)
      await client.query(
        `UPDATE auth_users SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
        values,
      )
      const user = await loadUser(id, client)
      if (!user) throw new Error('updated user disappeared')
      await client.query('COMMIT')
      return { before, user, changedFields }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async function setUserRolesIfChanged(
    userId: string, roles: string[], grantedBy: string,
  ): Promise<AuthUserMutationResult | null> {
    const nextRoles = [...new Set(roles)].sort()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // delete/updateUser と同じ lock 順にしてdeadlockを避ける。
      if (!nextRoles.includes('admin')) await assertAdminRemovalAllowed(client, userId)
      const locked = await client.query(
        `SELECT id FROM auth_users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [userId],
      )
      if (locked.rowCount === 0) {
        await client.query('ROLLBACK')
        return null
      }
      const before = await loadUser(userId, client)
      if (!before) throw new Error('locked user disappeared')
      if ([...before.roles].sort().join('\0') === nextRoles.join('\0')) {
        await client.query('COMMIT')
        return { before, user: before, changedFields: [] }
      }
      await client.query(`DELETE FROM auth_user_roles WHERE user_id = $1`, [userId])
      for (const role of nextRoles) {
        await client.query(
          `INSERT INTO auth_user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)`,
          [userId, role, grantedBy],
        )
      }
      const user = await loadUser(userId, client)
      if (!user) throw new Error('updated user disappeared')
      await client.query('COMMIT')
      return { before, user, changedFields: ['roles'] }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async function updateProfileIfChanged(
    id: string, patch: { username?: string | null; displayName?: string; signatureName: string },
  ): Promise<AuthUserMutationResult | null> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query(
        `SELECT id FROM auth_users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id],
      )
      if (locked.rowCount === 0) {
        await client.query('ROLLBACK')
        return null
      }
      const before = await loadUser(id, client)
      if (!before) throw new Error('locked user disappeared')
      const normalized = {
        username: patch.username === undefined ? undefined : patch.username?.trim().toLowerCase() || null,
        displayName: patch.displayName?.trim(),
        signatureName: patch.signatureName.trim(),
      }
      const changedFields = (Object.keys(normalized) as Array<keyof typeof normalized>)
        .filter(key => normalized[key] !== undefined && normalized[key] !== before[key])
      if (changedFields.length === 0) {
        await client.query('COMMIT')
        return { before, user: before, changedFields: [] }
      }
      const fields: string[] = []
      const values: unknown[] = []
      const columns = { username: 'username', displayName: 'display_name', signatureName: 'signature_name' } as const
      for (const key of changedFields) {
        values.push(normalized[key])
        fields.push(`${columns[key]} = $${values.length}`)
      }
      values.push(id)
      await client.query(
        `UPDATE auth_users SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
        values,
      )
      const user = await loadUser(id, client)
      if (!user) throw new Error('updated user disappeared')
      await client.query('COMMIT')
      return { before, user, changedFields }
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  return {
    async listUsers() {
      const r = await pool.query<AuthUserRow>(`${AUTH_USER_SELECT} WHERE u.deleted_at IS NULL ORDER BY u.created_at, u.id`)
      return r.rows.map(toUser)
    },

    getUser: loadUser,

    async createUser(input, existingClient) {
      const client = existingClient ?? await pool.connect()
      const ownClient = existingClient === undefined
      try {
        if (ownClient) await client.query('BEGIN')
        const id = newId()
        await client.query(
          `INSERT INTO auth_users (id, username, email, display_name, signature_name, status)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            input.username?.trim().toLowerCase() || null,
            input.email?.trim().toLowerCase() || null,
            input.displayName.trim(),
            input.displayName.trim(),
            input.status ?? 'active',
          ],
        )
        for (const role of [...new Set(input.roles ?? [])]) {
          await client.query(
            `INSERT INTO auth_user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)`,
            [id, role, input.createdBy ?? null],
          )
        }
        const user = await loadUser(id, client)
        if (!user) throw new Error('created user disappeared')
        if (ownClient) await client.query('COMMIT')
        return user
      } catch (e) {
        if (ownClient) await client.query('ROLLBACK')
        throw e
      } finally {
        if (ownClient) client.release()
      }
    },

    async updateUser(id, patch) {
      const fields: string[] = []
      const values: unknown[] = []
      if (patch.username !== undefined) {
        values.push(patch.username?.trim().toLowerCase() || null)
        fields.push(`username = $${values.length}`)
      }
      if (patch.email !== undefined) {
        values.push(patch.email?.trim().toLowerCase() || null)
        fields.push(`email = $${values.length}`)
      }
      if (patch.displayName !== undefined) {
        values.push(patch.displayName.trim())
        fields.push(`display_name = $${values.length}`)
      }
      if (patch.status !== undefined) {
        values.push(patch.status)
        fields.push(`status = $${values.length}`)
      }
      if (fields.length === 0) return loadUser(id)
      values.push(id)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (patch.status === 'disabled') await assertAdminRemovalAllowed(client, id)
        const r = await client.query(
          `UPDATE auth_users SET ${fields.join(', ')}, updated_at = now()
            WHERE id = $${values.length} AND deleted_at IS NULL RETURNING id`,
          values,
        )
        const user = r.rowCount === 0 ? null : await loadUser(id, client)
        await client.query('COMMIT')
        return user
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },

    updateUserIfChanged,

    async deleteUser(id) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await assertAdminRemovalAllowed(client, id)
        const r = await client.query(
          `UPDATE auth_users
              SET status = 'disabled', deleted_at = now(), updated_at = now()
            WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        )
        if ((r.rowCount ?? 0) > 0) {
          await client.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id])
        }
        await client.query('COMMIT')
        return (r.rowCount ?? 0) > 0
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },

    async updateSignatureName(id, signatureName) {
      const r = await pool.query(
        `UPDATE auth_users SET signature_name = $2, updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [id, signatureName.trim()],
      )
      return r.rowCount === 0 ? null : loadUser(id)
    },

    async setUserRoles(userId, roles, grantedBy) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (!roles.includes('admin')) await assertAdminRemovalAllowed(client, userId)
        const exists = await client.query(`SELECT 1 FROM auth_users WHERE id = $1 FOR UPDATE`, [userId])
        if (exists.rowCount === 0) {
          await client.query('ROLLBACK')
          return null
        }
        await client.query(`DELETE FROM auth_user_roles WHERE user_id = $1`, [userId])
        for (const role of [...new Set(roles)]) {
          await client.query(
            `INSERT INTO auth_user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)`,
            [userId, role, grantedBy],
          )
        }
        const user = await loadUser(userId, client)
        await client.query('COMMIT')
        return user
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },

    setUserRolesIfChanged,
    updateProfileIfChanged,

    async rolesExist(roles) {
      const unique = [...new Set(roles)]
      if (unique.length === 0) return true
      const r = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM auth_roles WHERE id = ANY($1::text[])`,
        [unique],
      )
      return Number(r.rows[0].count) === unique.length
    },

    async hasOtherActiveAdmin(userId) {
      const r = await pool.query(
        `SELECT 1
           FROM auth_users u JOIN auth_user_roles ur ON ur.user_id = u.id
          WHERE ur.role_id = 'admin' AND u.status = 'active' AND u.id <> $1
          LIMIT 1`,
        [userId],
      )
      return (r.rowCount ?? 0) > 0
    },

    async getLocalCredential(identifier) {
      const r = await pool.query<LocalCredentialRow>(
        `SELECT ${AUTH_USER_FIELDS}, lc.password_hash
           ${AUTH_USER_FROM}
           WHERE (lower(u.username) = lower($1) OR lower(u.email) = lower($1))
             AND lc.user_id IS NOT NULL AND u.deleted_at IS NULL`,
        [identifier.trim()],
      )
      const row = r.rows[0]
      if (!row) return null
      return {
        ...toUser(row),
        passwordHash: row.password_hash,
      }
    },

    async setLocalPassword(userId, hash, mustChange) {
      const r = await pool.query(
        `INSERT INTO auth_local_credentials
           (user_id, password_hash, password_changed_at, must_change_password)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (user_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               password_changed_at = now(), must_change_password = EXCLUDED.must_change_password`,
        [userId, hash, mustChange],
      )
      return (r.rowCount ?? 0) > 0
    },

    async recordSuccessfulLogin(userId) {
      await pool.query(
        `UPDATE auth_users SET last_login_at = now(), updated_at = now() WHERE id = $1`,
        [userId],
      )
    },

    async createSession(userId, cfg, metadata = {}, oidc) {
      const id = newId()
      const token = randomToken(32)
      const absolute = new Date(Date.now() + cfg.absoluteSeconds * 1000)
      const idle = new Date(Math.min(
        Date.now() + cfg.idleSeconds * 1000,
        absolute.getTime(),
      ))
      await pool.query(
        `INSERT INTO auth_sessions
          (id, user_id, token_hash, idle_expires_at, absolute_expires_at, ip_address, user_agent,
           oidc_issuer, oidc_subject, oidc_sid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id, userId, sha256(token), idle, absolute, metadata.ipAddress ?? null,
          metadata.userAgent?.slice(0, 1024) ?? null,
          oidc?.issuer ?? null, oidc?.subject ?? null, oidc?.sid ?? null,
        ],
      )
      return { id, token, expiresAt: absolute }
    },

    async authenticateSession(token, idleSeconds, touchIntervalSeconds = 300) {
      if (token.length < 32 || token.length > 256) return null
      const r = await pool.query<AuthUserRow & { session_id: string; last_seen_at: Date }>(
        `SELECT ${AUTH_USER_FIELDS}, s.id AS session_id, s.last_seen_at
           ${AUTH_USER_FROM}
           JOIN auth_sessions s ON s.user_id = u.id
          WHERE s.token_hash = $1 AND s.revoked_at IS NULL
            AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
            AND u.status = 'active' AND u.deleted_at IS NULL`,
        [sha256(token)],
      )
      const row = r.rows[0]
      if (!row) return null
      if (Date.now() - row.last_seen_at.getTime() >= touchIntervalSeconds * 1000) {
        await pool.query(
          `UPDATE auth_sessions
              SET last_seen_at = now(),
                  idle_expires_at = LEAST(absolute_expires_at, now() + ($2 * interval '1 second'))
            WHERE id = $1 AND revoked_at IS NULL`,
          [row.session_id, idleSeconds],
        )
      }
      return { kind: 'user', sessionId: row.session_id, user: toUser(row) }
    },

    async revokeSession(token) {
      const r = await pool.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
          WHERE token_hash = $1 AND revoked_at IS NULL`,
        [sha256(token)],
      )
      return (r.rowCount ?? 0) > 0
    },

    async revokeUserSessions(userId) {
      const r = await pool.query(
        `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      )
      return r.rowCount ?? 0
    },

    async getSessionOidcContext(token) {
      if (token.length < 32 || token.length > 256) return null
      const r = await pool.query<{ oidc_issuer: string; oidc_subject: string; oidc_sid: string | null }>(
        `SELECT oidc_issuer, oidc_subject, oidc_sid
           FROM auth_sessions
          WHERE token_hash = $1 AND oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL`,
        [sha256(token)],
      )
      const row = r.rows[0]
      return row ? { issuer: row.oidc_issuer, subject: row.oidc_subject, sid: row.oidc_sid } : null
    },

    async revokeOidcSessions(input) {
      if (!input.sid && !input.subject) return 0
      const r = input.sid
        ? await pool.query(
            `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
              WHERE oidc_issuer = $1 AND oidc_sid = $2 AND revoked_at IS NULL`,
            [input.issuer, input.sid],
          )
        : await pool.query(
            `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
              WHERE oidc_issuer = $1 AND oidc_subject = $2 AND revoked_at IS NULL`,
            [input.issuer, input.subject],
          )
      return r.rowCount ?? 0
    },

    async applyOidcBackchannelLogout(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const event = await client.query(
          `INSERT INTO auth_oidc_logout_events (issuer, jti, expires_at)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [input.issuer, input.jti, input.expiresAt],
        )
        if ((event.rowCount ?? 0) === 0) {
          await client.query('ROLLBACK')
          return { accepted: false, revoked: 0 }
        }
        const sessions = input.sid
          ? await client.query(
              `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
                WHERE oidc_issuer = $1 AND oidc_sid = $2 AND revoked_at IS NULL`,
              [input.issuer, input.sid],
            )
          : await client.query(
              `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
                WHERE oidc_issuer = $1 AND oidc_subject = $2 AND revoked_at IS NULL`,
              [input.issuer, input.subject],
            )
        await client.query('COMMIT')
        return { accepted: true, revoked: sessions.rowCount ?? 0 }
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },

    async deleteExpiredSessions() {
      const r = await pool.query(
        `DELETE FROM auth_sessions
          WHERE absolute_expires_at < now() - interval '7 days'
             OR revoked_at < now() - interval '7 days'`,
      )
      await pool.query(`DELETE FROM auth_oidc_logout_events WHERE expires_at < now()`)
      return r.rowCount ?? 0
    },

    async provisionOidcUser(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const identity = await client.query<{ user_id: string }>(
          `SELECT user_id FROM auth_oidc_identities
            WHERE issuer = $1 AND subject = $2 FOR UPDATE`,
          [input.issuer, input.subject],
        )
        let userId = identity.rows[0]?.user_id
        let created = false
        let linkedExisting = false

        if (!userId && input.autoLinkVerifiedEmail && input.emailVerified && input.email) {
          const match = await client.query<{ id: string; deleted_at: Date | null }>(
            `SELECT id, deleted_at FROM auth_users WHERE lower(email) = lower($1) FOR UPDATE`,
            [input.email],
          )
          if (match.rows[0]?.deleted_at) throw new Error('verified oidc email belongs to deleted user')
          if (match.rows[0]) {
            const candidate = await loadUserIncludingDeleted(match.rows[0].id, client)
            if (!candidate || candidate.roles.some(role => role !== 'viewer')) {
              throw new Error('privileged local user requires explicit oidc linking')
            }
            userId = match.rows[0].id
            linkedExisting = true
          }
        }

        if (!userId) {
          const candidate = input.username?.trim().toLowerCase()
          const validUsername = candidate && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(candidate)
            ? candidate
            : null
          const usernameTaken = validUsername
            ? (await client.query(`SELECT 1 FROM auth_users WHERE lower(username) = lower($1)`, [validUsername])).rowCount !== 0
            : false
          const id = newId()
          await client.query(
            `INSERT INTO auth_users (id, username, email, display_name, signature_name, status)
             VALUES ($1, $2, $3, $4, $4, 'active')`,
            [id, usernameTaken ? null : validUsername, input.emailVerified ? input.email?.trim().toLowerCase() || null : null, input.displayName.trim()],
          )
          userId = id
          created = true
          const initialRoles = input.managedRoles ?? [input.defaultRole]
          for (const role of [...new Set(initialRoles)]) {
            await client.query(
              `INSERT INTO auth_user_roles (user_id, role_id, granted_by) VALUES ($1, $2, NULL)`,
              [userId, role],
            )
          }
        }

        const before = await loadUserIncludingDeleted(userId, client)
        if (!before) throw new Error('oidc user missing')
        if (before.status !== 'active') throw new Error('user disabled')
        const managedRolesChanged = input.managedRoles !== undefined
          && [...before.roles].sort().join('\0') !== [...new Set(input.managedRoles)].sort().join('\0')
        if (input.managedRoles
            && before.roles.includes('admin')
            && !input.managedRoles.includes('admin')) {
          await assertAdminRemovalAllowed(client, userId)
        }

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
        if (input.managedRoles && managedRolesChanged) {
          await client.query(`DELETE FROM auth_user_roles WHERE user_id = $1`, [userId])
          for (const role of [...new Set(input.managedRoles)]) {
            await client.query(
              `INSERT INTO auth_user_roles (user_id, role_id, granted_by) VALUES ($1, $2, NULL)`,
              [userId, role],
            )
          }
        }
        const user = await loadUser(userId, client)
        if (!user) throw new Error('oidc user disappeared')
        await client.query('COMMIT')
        const profileChanged = before.displayName !== user.displayName
          || before.email !== user.email
          || managedRolesChanged
        return { user, created, linkedExisting, rolesBefore: before.roles, profileChanged }
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },
  }
}
