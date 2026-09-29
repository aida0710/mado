import type { Pool } from 'pg'
import { withTransaction, type Queryable } from '../db.js'
import type { AuthUser } from './auth-types.js'
import { AUTH_USER_FIELDS, AUTH_USER_FROM, toUser, type AuthUserRow } from './auth-user-query.js'
import { insertSession, revokeUserSessionRows, type CreatedSession, type NewSession } from './auth-session-store.js'

// Local User のパスワード（資格情報）と、それを使う login。
// パスワードが変わる操作は、session の失効まで同じ transaction で行う。途中で失敗して
// 「パスワードは変わったのに古い session が残る」状態を作らないため。
// ロックは user 行 → 資格情報の行 → session の順に取る。無効化・Role 変更・削除も
// user 行 → session の順なので、同じ User への操作が逆の順で待ち合って deadlock しない。

export interface LocalCredential extends AuthUser {
  passwordHash: string
}

type SessionRequest = Omit<NewSession, 'userId' | 'oidc'>

export interface CredentialStore {
  /** login 画面で入力された識別子 (username か email) で引く。 */
  findLocalCredentialByLogin(identifier: string): Promise<LocalCredential | null>
  getLocalCredential(userId: string): Promise<LocalCredential | null>
  /**
   * login を完了して session を発行する。検証に使った hash がまだ保存されているときだけ発行し、
   * 検証の間にパスワードが変わっていたら null を返す。rehashedPasswordHash を渡すと、
   * 同じ条件で新しいパラメータの hash に置き換える。
   */
  openLocalSession(input: {
    userId: string
    verifiedPasswordHash: string
    rehashedPasswordHash?: string
    session: SessionRequest
  }): Promise<CreatedSession | null>
  /**
   * 本人がパスワードを変える。保存 → 全 session の失効 → この browser 用の新しい session の発行。
   * 検証に使った hash が変わっていたら何もせず null を返す。
   */
  changeLocalPassword(input: {
    userId: string
    verifiedPasswordHash: string
    newPasswordHash: string
    session: SessionRequest
  }): Promise<CreatedSession | null>
  /** 管理者による再発行と bootstrap。次回の変更を必須にして保存し、全 session を失効させる。 */
  resetLocalPassword(userId: string, passwordHash: string): Promise<boolean>
}

const LOCAL_CREDENTIAL_SELECT = `SELECT ${AUTH_USER_FIELDS}, lc.password_hash ${AUTH_USER_FROM}`

function toLocalCredential(row: AuthUserRow & { password_hash: string }): LocalCredential {
  return { ...toUser(row), passwordHash: row.password_hash }
}

/** Local の資格情報を 1 行書く (無ければ作り、あれば置き換える)。User の作成と同じ transaction で使う。 */
export async function upsertLocalCredential(
  db: Queryable,
  { userId, passwordHash, mustChange }: { userId: string; passwordHash: string; mustChange: boolean },
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO auth_local_credentials (user_id, password_hash, password_changed_at, must_change_password)
     SELECT id, $2, now(), $3 FROM auth_users WHERE id = $1 AND deleted_at IS NULL
     ON CONFLICT (user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           password_changed_at = now(), must_change_password = EXCLUDED.must_change_password`,
    [userId, passwordHash, mustChange],
  )
  return (r.rowCount ?? 0) > 0
}

export function createCredentialStore(pool: Pool): CredentialStore {
  /**
   * User が有効で、検証に使った hash がまだ保存されているかを、user 行と資格情報の行を
   * ロックして確かめる。user 行は FOR NO KEY UPDATE にする。管理者の無効化とは待ち合い、
   * 自分が session を作るときの外部キーの検査（FOR KEY SHARE）とはぶつからない強さ。
   */
  async function lockIfPasswordUnchanged(
    db: Queryable,
    { userId, verifiedPasswordHash }: { userId: string; verifiedPasswordHash: string },
  ): Promise<boolean> {
    const r = await db.query<{ password_hash: string }>(
      `SELECT lc.password_hash
         FROM auth_users u JOIN auth_local_credentials lc ON lc.user_id = u.id
        WHERE u.id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
        FOR NO KEY UPDATE OF u FOR UPDATE OF lc`,
      [userId],
    )
    return r.rows[0]?.password_hash === verifiedPasswordHash
  }

  return {
    async findLocalCredentialByLogin(identifier) {
      const r = await pool.query<AuthUserRow & { password_hash: string }>(
        `${LOCAL_CREDENTIAL_SELECT}
          WHERE (lower(u.username) = lower($1) OR lower(u.email) = lower($1))
            AND lc.user_id IS NOT NULL AND u.deleted_at IS NULL`,
        [identifier.trim()],
      )
      return r.rows[0] ? toLocalCredential(r.rows[0]) : null
    },

    async getLocalCredential(userId) {
      const r = await pool.query<AuthUserRow & { password_hash: string }>(
        `${LOCAL_CREDENTIAL_SELECT} WHERE u.id = $1 AND lc.user_id IS NOT NULL AND u.deleted_at IS NULL`,
        [userId],
      )
      return r.rows[0] ? toLocalCredential(r.rows[0]) : null
    },

    openLocalSession: ({ userId, verifiedPasswordHash, rehashedPasswordHash, session }) =>
      withTransaction(pool, async client => {
        if (!await lockIfPasswordUnchanged(client, { userId, verifiedPasswordHash })) return null
        if (rehashedPasswordHash) {
          // パスワードそのものは変わっていないので password_changed_at は動かさない。
          await client.query(
            `UPDATE auth_local_credentials SET password_hash = $2 WHERE user_id = $1`,
            [userId, rehashedPasswordHash],
          )
        }
        await client.query(`UPDATE auth_users SET last_login_at = now(), updated_at = now() WHERE id = $1`, [userId])
        return insertSession(client, { userId, ...session })
      }),

    changeLocalPassword: ({ userId, verifiedPasswordHash, newPasswordHash, session }) =>
      withTransaction(pool, async client => {
        if (!await lockIfPasswordUnchanged(client, { userId, verifiedPasswordHash })) return null
        if (!await upsertLocalCredential(client, { userId, passwordHash: newPasswordHash, mustChange: false })) return null
        await revokeUserSessionRows(client, userId)
        return insertSession(client, { userId, ...session })
      }),

    resetLocalPassword: (userId, passwordHash) => withTransaction(pool, async client => {
      const user = await client.query(
        `SELECT id FROM auth_users WHERE id = $1 AND deleted_at IS NULL FOR NO KEY UPDATE`, [userId],
      )
      if (user.rowCount === 0) return false
      if (!await upsertLocalCredential(client, { userId, passwordHash, mustChange: true })) return false
      await revokeUserSessionRows(client, userId)
      return true
    }),
  }
}
