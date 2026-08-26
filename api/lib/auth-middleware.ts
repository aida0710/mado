import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AuthStore } from './auth-store.js'
import { SESSION_COOKIE } from './auth-types.js'
import { setSessionPrincipal } from './rbac.js'

export interface SessionMiddlewareConfig {
  idleSeconds: number
  cookieName?: string
}

export function requireSession(
  store: AuthStore,
  cfg: SessionMiddlewareConfig,
): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, cfg.cookieName ?? SESSION_COOKIE)
    if (!token) return c.json({ error: 'unauthorized' }, 401)
    const principal = await store.authenticateSession(token, cfg.idleSeconds)
    if (!principal) return c.json({ error: 'unauthorized' }, 401)
    setSessionPrincipal(c, principal)
    await next()
  }
}
