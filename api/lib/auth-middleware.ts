import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { AuthStore } from './auth-store.js'
import { SESSION_COOKIE } from './auth-types.js'
import { getSessionPrincipal, setSessionPrincipal } from './rbac.js'

export interface SessionMiddlewareConfig {
  idleSeconds: number
  cookieName?: string
  onDenied?: (c: Context, reason: 'missing' | 'invalid') => Promise<void>
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
  store: AuthStore,
  cfg: SessionMiddlewareConfig,
): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, cfg.cookieName ?? SESSION_COOKIE)
    if (!token) {
      await cfg.onDenied?.(c, 'missing').catch(error => console.error('session denial audit failed', error))
      return c.json({ error: 'unauthorized' }, 401)
    }
    const principal = await store.authenticateSession(token, cfg.idleSeconds)
    if (!principal) {
      await cfg.onDenied?.(c, 'invalid').catch(error => console.error('session denial audit failed', error))
      return c.json({ error: 'unauthorized' }, 401)
    }
    setSessionPrincipal(c, principal)
    await next()
  }
}
