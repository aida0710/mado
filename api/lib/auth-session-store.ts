import type { Pool } from 'pg'
import { withTransaction, type Queryable } from '../db.js'
import type { RequestMetadata, SessionPrincipal } from './auth-types.js'
import { newId, randomToken, sha256 } from './auth-crypto.js'
import { AUTH_USER_FIELDS, AUTH_USER_FROM, toUser, type AuthUserRow } from './auth-user-query.js'

// browser session の発行・認証・失効。

// session token は 32 byte の乱数 (base64url で 43 文字)。これを大きく外れる値は DB を引かずに捨てる。
const SESSION_TOKEN_MIN_LENGTH = 32
const SESSION_TOKEN_MAX_LENGTH = 256
// last_seen_at と idle 期限の更新を、request ごとではなくこの間隔に間引いて書き込みを減らす。
const SESSION_TOUCH_INTERVAL_SECONDS = 300
// 失効・期限切れの session 行は、監査で追えるよう少し残してから消す。
const EXPIRED_SESSION_RETENTION = `interval '7 days'`

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

export interface OidcBackchannelLogout {
  issuer: string
  subject?: string | null
  sid?: string | null
  jti: string
  expiresAt: Date
}

export interface NewSession {
  userId: string
  lifetime: SessionLifetime
  metadata?: RequestMetadata
  oidc?: OidcSessionContext
}

export interface SessionStore {
  createSession(input: NewSession): Promise<CreatedSession>
  authenticateSession(token: string, idleSeconds: number, touchIntervalSeconds?: number): Promise<SessionPrincipal | null>
  revokeSession(token: string): Promise<boolean>
  getSessionOidcContext(token: string): Promise<OidcSessionContext | null>
  revokeOidcSessions(target: OidcSessionTarget): Promise<number>
  applyOidcBackchannelLogout(input: OidcBackchannelLogout): Promise<{ accepted: boolean; revoked: number }>
  deleteExpiredSessions(): Promise<number>
}

/** OIDC の sid があればその session だけ、無ければ subject の全 session を指す。 */
export interface OidcSessionTarget {
  issuer: string
  subject?: string | null
  sid?: string | null
}

function isPlausibleToken(token: string): boolean {
  return token.length >= SESSION_TOKEN_MIN_LENGTH && token.length <= SESSION_TOKEN_MAX_LENGTH
}

/** session を 1 行作る。資格の変更と同じ transaction で発行したいときは client を渡す。 */
export async function insertSession(db: Queryable, { userId, lifetime, metadata = {}, oidc }: NewSession): Promise<CreatedSession> {
  const id = newId()
  const token = randomToken(32)
  const absolute = new Date(Date.now() + lifetime.absoluteSeconds * 1000)
  const idle = new Date(Math.min(Date.now() + lifetime.idleSeconds * 1000, absolute.getTime()))
  await db.query(
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
}

/** User の有効な session をすべて失効させる。資格が変わる操作と同じ transaction で呼ぶ。 */
export async function revokeUserSessionRows(db: Queryable, userId: string): Promise<number> {
  const r = await db.query(
    `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  )
  return r.rowCount ?? 0
}

async function revokeOidcSessionRows(db: Queryable, target: OidcSessionTarget): Promise<number> {
  if (!target.sid && !target.subject) return 0
  const [column, value] = target.sid ? ['oidc_sid', target.sid] : ['oidc_subject', target.subject]
  const r = await db.query(
    `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now())
      WHERE oidc_issuer = $1 AND ${column} = $2 AND revoked_at IS NULL`,
    [target.issuer, value],
  )
  return r.rowCount ?? 0
}

export function createSessionStore(pool: Pool): SessionStore {
  return {
    createSession: input => insertSession(pool, input),

    async authenticateSession(token, idleSeconds, touchIntervalSeconds = SESSION_TOUCH_INTERVAL_SECONDS) {
      if (!isPlausibleToken(token)) return null
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

    async getSessionOidcContext(token) {
      if (!isPlausibleToken(token)) return null
      const r = await pool.query<{ oidc_issuer: string; oidc_subject: string; oidc_sid: string | null }>(
        `SELECT oidc_issuer, oidc_subject, oidc_sid
           FROM auth_sessions
          WHERE token_hash = $1 AND oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL`,
        [sha256(token)],
      )
      const row = r.rows[0]
      return row ? { issuer: row.oidc_issuer, subject: row.oidc_subject, sid: row.oidc_sid } : null
    },

    revokeOidcSessions: target => revokeOidcSessionRows(pool, target),

    applyOidcBackchannelLogout: input => withTransaction(pool, async client => {
      // 同じ logout token (jti) を 2 度受け付けない。
      const event = await client.query(
        `INSERT INTO auth_oidc_logout_events (issuer, jti, expires_at)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [input.issuer, input.jti, input.expiresAt],
      )
      if ((event.rowCount ?? 0) === 0) return { accepted: false, revoked: 0 }
      return { accepted: true, revoked: await revokeOidcSessionRows(client, input) }
    }),

    async deleteExpiredSessions() {
      const r = await pool.query(
        `DELETE FROM auth_sessions
          WHERE absolute_expires_at < now() - ${EXPIRED_SESSION_RETENTION}
             OR revoked_at < now() - ${EXPIRED_SESSION_RETENTION}`,
      )
      await pool.query(`DELETE FROM auth_oidc_logout_events WHERE expires_at < now()`)
      return r.rowCount ?? 0
    },
  }
}
