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
}

interface LocalCredentialRow extends AuthUserRow {
  password_hash: string
  failed_attempts: number
  locked_until: Date | null
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
         COALESCE(lc.must_change_password, FALSE) AS must_change_password`

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

export interface AuthStore {
  listUsers(): Promise<AuthUser[]>
  getUser(id: string): Promise<AuthUser | null>
  createUser(input: CreateUserInput, client?: PoolClient): Promise<AuthUser>
  updateUser(id: string, patch: { username?: string | null; email?: string | null; displayName?: string; status?: UserStatus }): Promise<AuthUser | null>
  updateSignatureName(id: string, signatureName: string): Promise<AuthUser | null>
  setUserRoles(userId: string, roles: string[], grantedBy: string): Promise<AuthUser | null>
  rolesExist(roles: string[]): Promise<boolean>
  hasOtherActiveAdmin(userId: string): Promise<boolean>
  getLocalCredential(identifier: string): Promise<(AuthUser & {
    passwordHash: string
    failedAttempts: number
    lockedUntil: Date | null
  }) | null>
  setLocalPassword(userId: string, hash: string, mustChange: boolean): Promise<boolean>
  recordFailedLogin(userId: string, threshold: number, lockSeconds: number): Promise<void>
  recordSuccessfulLogin(userId: string): Promise<void>
  createSession(userId: string, cfg: SessionLifetime, metadata?: RequestMetadata): Promise<CreatedSession>
  authenticateSession(token: string, idleSeconds: number, touchIntervalSeconds?: number): Promise<SessionPrincipal | null>
  revokeSession(token: string): Promise<boolean>
  revokeUserSessions(userId: string): Promise<number>
  deleteExpiredSessions(): Promise<number>
  findOidcIdentity(issuer: string, subject: string): Promise<AuthUser | null>
  createOidcIdentityUser(input: {
    issuer: string
    subject: string
    email?: string | null
    displayName: string
    defaultRole?: string
  }): Promise<AuthUser>
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

export function createAuthStore(pool: Pool): AuthStore {
  async function loadUser(id: string, client: Pool | PoolClient = pool): Promise<AuthUser | null> {
    const r = await client.query<AuthUserRow>(`${AUTH_USER_SELECT} WHERE u.id = $1`, [id])
    return r.rows[0] ? toUser(r.rows[0]) : null
  }

  return {
    async listUsers() {
      const r = await pool.query<AuthUserRow>(`${AUTH_USER_SELECT} ORDER BY u.created_at, u.id`)
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
      const r = await pool.query(
        `UPDATE auth_users SET ${fields.join(', ')}, updated_at = now()
          WHERE id = $${values.length} RETURNING id`,
        values,
      )
      return r.rowCount === 0 ? null : loadUser(id)
    },

    async updateSignatureName(id, signatureName) {
      const r = await pool.query(
        `UPDATE auth_users SET signature_name = $2, updated_at = now()
          WHERE id = $1 RETURNING id`,
        [id, signatureName.trim()],
      )
      return r.rowCount === 0 ? null : loadUser(id)
    },

    async setUserRoles(userId, roles, grantedBy) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
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
        `SELECT ${AUTH_USER_FIELDS}, lc.password_hash, lc.failed_attempts, lc.locked_until
           ${AUTH_USER_FROM}
           WHERE (lower(u.username) = lower($1) OR lower(u.email) = lower($1))
             AND lc.user_id IS NOT NULL`,
        [identifier.trim()],
      )
      const row = r.rows[0]
      if (!row) return null
      return {
        ...toUser(row),
        passwordHash: row.password_hash,
        failedAttempts: row.failed_attempts,
        lockedUntil: row.locked_until,
      }
    },

    async setLocalPassword(userId, hash, mustChange) {
      const r = await pool.query(
        `INSERT INTO auth_local_credentials
           (user_id, password_hash, password_changed_at, failed_attempts, locked_until, must_change_password)
         VALUES ($1, $2, now(), 0, NULL, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               password_changed_at = now(), failed_attempts = 0,
               locked_until = NULL, must_change_password = EXCLUDED.must_change_password`,
        [userId, hash, mustChange],
      )
      return (r.rowCount ?? 0) > 0
    },

    async recordFailedLogin(userId, threshold, lockSeconds) {
      await pool.query(
        `UPDATE auth_local_credentials
            SET failed_attempts = failed_attempts + 1,
                locked_until = CASE WHEN failed_attempts + 1 >= $2
                  THEN now() + ($3 * interval '1 second') ELSE locked_until END
          WHERE user_id = $1`,
        [userId, threshold, lockSeconds],
      )
    },

    async recordSuccessfulLogin(userId) {
      await pool.query(
        `WITH credential AS (
           UPDATE auth_local_credentials SET failed_attempts = 0, locked_until = NULL
            WHERE user_id = $1
         )
         UPDATE auth_users SET last_login_at = now(), updated_at = now() WHERE id = $1`,
        [userId],
      )
    },

    async createSession(userId, cfg, metadata = {}) {
      const id = newId()
      const token = randomToken(32)
      const absolute = new Date(Date.now() + cfg.absoluteSeconds * 1000)
      const idle = new Date(Math.min(
        Date.now() + cfg.idleSeconds * 1000,
        absolute.getTime(),
      ))
      await pool.query(
        `INSERT INTO auth_sessions
          (id, user_id, token_hash, idle_expires_at, absolute_expires_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, userId, sha256(token), idle, absolute, metadata.ipAddress ?? null, metadata.userAgent?.slice(0, 1024) ?? null],
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
            AND u.status = 'active'`,
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

    async deleteExpiredSessions() {
      const r = await pool.query(
        `DELETE FROM auth_sessions
          WHERE absolute_expires_at < now() - interval '7 days'
             OR revoked_at < now() - interval '7 days'`,
      )
      return r.rowCount ?? 0
    },

    async findOidcIdentity(issuer, subject) {
      const r = await pool.query<{ user_id: string }>(
        `UPDATE auth_oidc_identities SET last_login_at = now()
          WHERE issuer = $1 AND subject = $2 RETURNING user_id`,
        [issuer, subject],
      )
      return r.rows[0] ? loadUser(r.rows[0].user_id) : null
    },

    async createOidcIdentityUser(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const user = await this.createUser({
          email: input.email,
          displayName: input.displayName,
          roles: [input.defaultRole ?? 'viewer'],
        }, client)
        await client.query(
          `INSERT INTO auth_oidc_identities (issuer, subject, user_id, email_at_login)
           VALUES ($1, $2, $3, $4)`,
          [input.issuer, input.subject, user.id, input.email ?? null],
        )
        await client.query('COMMIT')
        return user
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      } finally {
        client.release()
      }
    },
  }
}
