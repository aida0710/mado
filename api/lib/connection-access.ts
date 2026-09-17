import type { Context, MiddlewareHandler } from 'hono'
import type { Pool } from 'pg'
import { hasPermission } from './auth-types.js'
import { getSessionPrincipal } from './rbac.js'

/** 認証無効の開発環境と接続管理者は全接続へアクセスできる。 */
export function managesConnections(c: Context): boolean {
  const principal = getSessionPrincipal(c)
  return principal === null || hasPermission(principal, 'connections:manage')
}

/** 現在のUserが接続を利用できるか。非許可時は存在自体を隠すため呼び出し側は404にする。 */
export async function canAccessConnection(
  pool: Pool,
  c: Context,
  connectionId: string,
): Promise<boolean> {
  if (managesConnections(c)) return true
  const principal = getSessionPrincipal(c)!
  const result = await pool.query(
    `SELECT 1
       FROM storage_connections connection
      WHERE connection.id = $1
        AND (
          connection.visibility_mode = 'public'
          OR EXISTS (
            SELECT 1 FROM connection_user_allowlist allowed
             WHERE allowed.connection_id = connection.id
               AND allowed.user_id = $2
          )
        )`,
    [connectionId, principal.user.id],
  )
  return (result.rowCount ?? 0) > 0
}

/** nullは「管理者なので全件」。通常Userは利用可能なconnection IDだけを返す。 */
export async function visibleConnectionIds(pool: Pool, c: Context): Promise<Set<string> | null> {
  if (managesConnections(c)) return null
  const principal = getSessionPrincipal(c)!
  const result = await pool.query<{ id: string }>(
    `SELECT connection.id
       FROM storage_connections connection
      WHERE connection.visibility_mode = 'public'
         OR EXISTS (
           SELECT 1 FROM connection_user_allowlist allowed
            WHERE allowed.connection_id = connection.id
              AND allowed.user_id = $1
         )`,
    [principal.user.id],
  )
  return new Set(result.rows.map(row => row.id))
}

export function requireConnectionAccess(pool: Pool): MiddlewareHandler {
  return async (c, next) => {
    const connectionId = c.req.param('connectionId')
    if (!connectionId) return c.json({ error: 'connectionId required' }, 400)
    if (!await canAccessConnection(pool, c, connectionId)) {
      return c.json({ error: 'connection not found' }, 404)
    }
    await next()
  }
}

export function requireConnectionQueryAccess(pool: Pool): MiddlewareHandler {
  return async (c, next) => {
    const connectionId = c.req.query('connectionId')
    if (!connectionId) return c.json({ error: 'connectionId required' }, 400)
    if (!await canAccessConnection(pool, c, connectionId)) {
      return c.json({ error: 'connection not found' }, 404)
    }
    await next()
  }
}
