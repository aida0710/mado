import type { Queryable } from '../db.js'
import type { AuthUser, UserStatus } from './auth-types.js'

// AuthUser を 1 行で組み立てる SQL と変換、読み取り。User・パスワード・session・SSO の各 store が共有する。

export interface AuthUserRow {
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

export const AUTH_USER_FIELDS = `u.id, u.username, u.email, u.display_name, u.signature_name, u.status,
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

export const AUTH_USER_FROM = `FROM auth_users u
    LEFT JOIN auth_local_credentials lc ON lc.user_id = u.id`

export const AUTH_USER_SELECT = `SELECT ${AUTH_USER_FIELDS} ${AUTH_USER_FROM}`

export function toUser(row: AuthUserRow): AuthUser {
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

export async function loadUser(db: Queryable, id: string): Promise<AuthUser | null> {
  const r = await db.query<AuthUserRow>(`${AUTH_USER_SELECT} WHERE u.id = $1 AND u.deleted_at IS NULL`, [id])
  return r.rows[0] ? toUser(r.rows[0]) : null
}

export async function loadUserIncludingDeleted(db: Queryable, id: string): Promise<AuthUser | null> {
  const r = await db.query<AuthUserRow>(`${AUTH_USER_SELECT} WHERE u.id = $1`, [id])
  return r.rows[0] ? toUser(r.rows[0]) : null
}

/** username と email は大文字小文字を区別せずに一意なので、保存と検索の前にそろえる。空は null。 */
export function normalizeLoginName(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null
}
