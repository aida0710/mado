import type { PoolClient } from 'pg'
import type { UserStatus } from './auth-types.js'

// 「active な Admin を 0 人にしない」という不変条件。無効化・削除・Role 変更・SSO の Role 同期の
// すべてがここを通る。ロックの順は advisory lock → user 行 → (資格情報の行) → session にそろえる。

export const ADMIN_ROLE = 'admin'

export class LastActiveAdminError extends Error {
  constructor() {
    super('cannot remove the last active admin')
    this.name = 'LastActiveAdminError'
  }
}

/**
 * userId から Admin を外してよいかを確かめ、だめなら LastActiveAdminError を投げる。
 * 同時に 2 人の Admin を外して 0 人になるのを防ぐため、advisory lock で Admin 集合への操作を直列にし、
 * そのあと対象の行をロックする。Admin 集合を触る経路はすべてこの順 (advisory lock → user 行) にそろえ、
 * deadlock を避ける。呼び出し側の transaction の中で呼ぶこと。
 */
export async function assertAdminRemovalAllowed(client: PoolClient, userId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('mado-active-admin-invariant'))`)
  const target = await client.query<{ status: UserStatus; is_admin: boolean }>(
    `SELECT u.status,
            EXISTS (SELECT 1 FROM auth_user_roles ur WHERE ur.user_id = u.id AND ur.role_id = $2) AS is_admin
       FROM auth_users u
      WHERE u.id = $1 AND u.deleted_at IS NULL
      FOR UPDATE`,
    [userId, ADMIN_ROLE],
  )
  if (target.rows[0]?.status !== 'active' || !target.rows[0]?.is_admin) return
  const admins = await client.query<{ count: string }>(
    `SELECT count(DISTINCT u.id)::text AS count
       FROM auth_users u
       JOIN auth_user_roles ur ON ur.user_id = u.id AND ur.role_id = $1
      WHERE u.status = 'active' AND u.deleted_at IS NULL`,
    [ADMIN_ROLE],
  )
  if (Number(admins.rows[0]?.count ?? 0) <= 1) throw new LastActiveAdminError()
}
