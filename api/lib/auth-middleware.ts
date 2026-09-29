import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { SessionStore } from './auth-session-store.js'
import { getSessionPrincipal, setSessionPrincipal } from './rbac.js'

export interface SessionMiddlewareConfig {
  idleSeconds: number
  cookieName: string
}

/** 初期・一時passwordの変更前は、認証済みでも通常APIを利用させない。 */
export function requirePasswordChangeComplete(): MiddlewareHandler {
  return async (c, next) => {
    const principal = getSessionPrincipal(c)
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    if (principal.user.mustChangePassword) {
      return c.json({ error: 'password change required' }, 403)
    }
    await next()
  }
}

export function requireSession(
  sessions: Pick<SessionStore, 'authenticateSession'>,
  config: SessionMiddlewareConfig,
): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, config.cookieName)
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    const principal = await sessions.authenticateSession(token, config.idleSeconds)
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    setSessionPrincipal(c, principal)
    await next()
  }
}
