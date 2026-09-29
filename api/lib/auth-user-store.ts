import type { Pool, PoolClient } from 'pg'
import { withTransaction } from '../db.js'
import type { AuthUser, UserStatus } from './auth-types.js'
import { newId } from './auth-crypto.js'
import { AUTH_USER_SELECT, loadUser, normalizeLoginName, toUser, type AuthUserRow } from './auth-user-query.js'
import { ADMIN_ROLE, assertAdminRemovalAllowed } from './auth-admin-invariant.js'
import { revokeUserSessionRows } from './auth-session-store.js'
import { upsertLocalCredential } from './auth-credential-store.js'

// 管理画面・本人の Account 画面・bootstrap が使う、User と Role の読み書き。
// 権限や状態が変わる操作 (無効化・Role の変更・削除) は、session の失効まで同じ transaction で行う。

export interface CreateUserInput {
  username?: string | null
  email?: string | null
  displayName: string
  status?: UserStatus
  roles?: string[]
  createdBy?: string | null
  /** 渡すと Local のパスワードも同じ transaction で保存する。 */
  localPassword?: { hash: string; mustChange: boolean }
}

/** 変更の前後と、実際に変わった項目。変わっていなければ changedFields は空で、DB は触っていない。 */
export interface AuthUserMutationResult {
  before: AuthUser
  user: AuthUser
  changedFields: string[]
}

export interface UserStore {
  listUsers(): Promise<AuthUser[]>
  getUser(id: string): Promise<AuthUser | null>
  rolesExist(roles: string[]): Promise<boolean>
  createUser(input: CreateUserInput): Promise<AuthUser>
  /** 無効にしたら、その User の session もすべて失効させる。 */
  updateUser(id: string, patch: {
    username?: string | null; email?: string | null; displayName?: string; status?: UserStatus
  }): Promise<AuthUserMutationResult | null>
  updateProfile(id: string, patch: {
    username?: string | null; displayName?: string; signatureName: string
  }): Promise<AuthUserMutationResult | null>
  /** Role を置き換える。変わったら session を失効させ、新しい Role で入り直させる。 */
  replaceUserRoles(id: string, roles: string[], grantedBy: string): Promise<AuthUserMutationResult | null>
  /** 過去の監査から辿れるよう行は残す論理削除。session も失効させる。 */
  deleteUser(id: string): Promise<boolean>
}

export function sameRoleSet(a: readonly string[], b: readonly string[]): boolean {
  return [...new Set(a)].sort().join('\0') === [...new Set(b)].sort().join('\0')
}

/** User の Role を roles に置き換える。grantedBy が null なのは SSO の group から付けた Role。 */
export async function replaceRoleRows(
  client: PoolClient,
  { userId, roles, grantedBy }: { userId: string; roles: readonly string[]; grantedBy: string | null },
): Promise<void> {
  await client.query(`DELETE FROM auth_user_roles WHERE user_id = $1`, [userId])
  for (const role of new Set(roles)) {
    await client.query(
      `INSERT INTO auth_user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)`,
      [userId, role, grantedBy],
    )
  }
}

/** auth_users に 1 行と Role を入れる。SSO の JIT 作成も同じ形で使う。 */
export async function insertUserRow(client: PoolClient, input: {
  username: string | null
  email: string | null
  displayName: string
  status: UserStatus
  roles: readonly string[]
  grantedBy: string | null
}): Promise<string> {
  const id = newId()
  const displayName = input.displayName.trim()
  await client.query(
    `INSERT INTO auth_users (id, username, email, display_name, signature_name, status)
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [id, input.username, input.email, displayName, input.status],
  )
  await replaceRoleRows(client, { userId: id, roles: input.roles, grantedBy: input.grantedBy })
  return id
}

// 編集できる列と、その DB 列名。undefined を渡した項目は「変更しない」。
const EDITABLE_USER_COLUMNS = {
  username: 'username',
  email: 'email',
  displayName: 'display_name',
  status: 'status',
  signatureName: 'signature_name',
} as const
type EditableUserField = keyof typeof EDITABLE_USER_COLUMNS

/** 削除されていない User の行をロックし、変更前の値を返す。無ければ null。 */
async function lockUser(client: PoolClient, id: string): Promise<AuthUser | null> {
  const locked = await client.query(`SELECT id FROM auth_users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])
  if (locked.rowCount === 0) return null
  return loadUser(client, id)
}

async function reloadUser(client: PoolClient, id: string): Promise<AuthUser> {
  const user = await loadUser(client, id)
  if (!user) throw new Error('locked user disappeared')
  return user
}

export function createUserStore(pool: Pool): UserStore {
  /** 値が変わった列だけ UPDATE する。変更が無ければ DB を書かない。 */
  const updateFieldsIfChanged = (
    id: string,
    normalized: Partial<Pick<AuthUser, EditableUserField>>,
  ): Promise<AuthUserMutationResult | null> => withTransaction(pool, async client => {
    // Admin を外しうる操作は、advisory lock → user 行の順でロックする (auth-admin-invariant.ts)。
    if (normalized.status === 'disabled') await assertAdminRemovalAllowed(client, id)
    const before = await lockUser(client, id)
    if (!before) return null
    const changedFields = (Object.keys(normalized) as EditableUserField[])
      .filter(key => normalized[key] !== undefined && normalized[key] !== before[key])
    if (changedFields.length === 0) return { before, user: before, changedFields: [] }

    const values: unknown[] = changedFields.map(key => normalized[key])
    const assignments = changedFields.map((key, index) => `${EDITABLE_USER_COLUMNS[key]} = $${index + 1}`)
    values.push(id)
    await client.query(
      `UPDATE auth_users SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
      values,
    )
    if (changedFields.includes('status') && normalized.status === 'disabled') {
      await revokeUserSessionRows(client, id)
    }
    return { before, user: await reloadUser(client, id), changedFields }
  })

  return {
    async listUsers() {
      const r = await pool.query<AuthUserRow>(`${AUTH_USER_SELECT} WHERE u.deleted_at IS NULL ORDER BY u.created_at, u.id`)
      return r.rows.map(toUser)
    },

    getUser: id => loadUser(pool, id),

    async rolesExist(roles) {
      const unique = [...new Set(roles)]
      if (unique.length === 0) return true
      const r = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM auth_roles WHERE id = ANY($1::text[])`,
        [unique],
      )
      return Number(r.rows[0].count) === unique.length
    },

    createUser: input => withTransaction(pool, async client => {
      const id = await insertUserRow(client, {
        username: normalizeLoginName(input.username),
        email: normalizeLoginName(input.email),
        displayName: input.displayName,
        status: input.status ?? 'active',
        roles: input.roles ?? [],
        grantedBy: input.createdBy ?? null,
      })
      if (input.localPassword) {
        await upsertLocalCredential(client, {
          userId: id, passwordHash: input.localPassword.hash, mustChange: input.localPassword.mustChange,
        })
      }
      return reloadUser(client, id)
    }),

    updateUser: (id, patch) => updateFieldsIfChanged(id, {
      username: patch.username === undefined ? undefined : normalizeLoginName(patch.username),
      email: patch.email === undefined ? undefined : normalizeLoginName(patch.email),
      displayName: patch.displayName?.trim(),
      status: patch.status,
    }),

    updateProfile: (id, patch) => updateFieldsIfChanged(id, {
      username: patch.username === undefined ? undefined : normalizeLoginName(patch.username),
      displayName: patch.displayName?.trim(),
      signatureName: patch.signatureName.trim(),
    }),

    replaceUserRoles: (id, roles, grantedBy) => withTransaction(pool, async client => {
      if (!roles.includes(ADMIN_ROLE)) await assertAdminRemovalAllowed(client, id)
      const before = await lockUser(client, id)
      if (!before) return null
      if (sameRoleSet(before.roles, roles)) return { before, user: before, changedFields: [] }
      await replaceRoleRows(client, { userId: id, roles, grantedBy })
      await revokeUserSessionRows(client, id)
      return { before, user: await reloadUser(client, id), changedFields: ['roles'] }
    }),

    deleteUser: id => withTransaction(pool, async client => {
      await assertAdminRemovalAllowed(client, id)
      const r = await client.query(
        `UPDATE auth_users
            SET status = 'disabled', deleted_at = now(), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      )
      if ((r.rowCount ?? 0) === 0) return false
      await revokeUserSessionRows(client, id)
      return true
    }),
  }
}
